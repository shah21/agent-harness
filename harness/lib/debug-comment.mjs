export const DEBUG_MARKER = '<!-- agent-debug -->';
const MAX_CHARS = 60000;

const bullets = (items) => items.map((x) => `- ${x}`).join('\n');
const runLink = (runUrl) => `[Run log and artifacts](${runUrl})`;

// A fence longer than any tilde run inside the text, so command output cannot close it early.
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/~+/g) ?? []).map((m) => m.length));
  const fence = '~'.repeat(Math.max(3, longest + 1));
  return [fence, text, fence].join('\n');
}

function reportSections(v, evidence) {
  const r = v.report;
  const lines = [];
  const section = (title, body) => {
    if (body) lines.push(`**${title}**`, body, '');
  };
  section('Problem', r.problem);
  section('Reproduction', r.reproduction);
  section('Investigated', v.investigated?.length ? bullets(v.investigated.map((i) => `\`${i.path}\` @ \`${i.sha}\``)) : '');
  section('Evidence', evidence ? fenced(evidence) : '');
  section('Hypotheses', r.hypotheses?.length ? r.hypotheses.map((h, i) => `${i + 1}. ${h.text}`).join('\n') : '');
  section('Root cause', r.rootCause);
  section('Owning module', r.owningModule);
  section('Next action', r.nextAction);
  section('Unknowns', r.unknowns);
  section('Human input needed', r.humanInput);
  return lines;
}

function build(v, runUrl, evidence) {
  const lines = [];
  if (v.outcome === 'WAITING') {
    lines.push(`⏸️ **WAITING** (${v.kind})`, '', bullets(v.reasons), '', 'The issue stays queued. A scheduled run retries it once an account has usage again.', '');
  } else if (v.outcome === 'BLOCKED') {
    lines.push(`⛔ **BLOCKED** (${v.kind})`, '', bullets(v.reasons), '');
    if (v.report) lines.push(...reportSections(v, evidence));
  } else {
    lines.push(`🔎 **${v.outcome}**`, '', ...reportSections(v, evidence));
  }
  if (v.warnings?.length) lines.push('**Warnings**', bullets(v.warnings), '');
  lines.push(runLink(runUrl));
  if (v.outcome === 'BLOCKED') lines.push('', 'To retry: remove `agent:blocked` and add `debug`.');
  lines.push('', DEBUG_MARKER);
  return lines.join('\n');
}

export function renderDebugComment(v, { runUrl }) {
  const evidence = v.report?.evidence ?? '';
  const out = build(v, runUrl, evidence);
  if (out.length <= MAX_CHARS) return out;
  const keep = Math.max(0, evidence.length - (out.length - MAX_CHARS) - 200);
  return build(v, runUrl, `${evidence.slice(0, keep)}\n… (truncated; the full report is in the run artifact)`);
}
