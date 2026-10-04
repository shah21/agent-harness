import { taskMarker } from './queue.mjs';

function checkTable(checks) {
  const rows = Object.entries(checks ?? {}).map(([name, c]) => {
    const result = c.ok ? 'PASS' : c.timedOut ? 'TIMEOUT' : `FAIL (exit ${c.exitCode})`;
    return `| ${name} | ${result} |`;
  });
  return ['| Check | Result |', '|---|---|', ...rows].join('\n');
}

// A fence longer than any tilde run inside the text, so command output cannot close it early.
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/~+/g) ?? []).map((m) => m.length));
  const fence = '~'.repeat(Math.max(3, longest + 1));
  return [fence, text, fence].join('\n');
}

function checkTails(checks) {
  return Object.entries(checks ?? {})
    .filter(([, c]) => !c.ok && c.tail)
    .flatMap(([name, c]) => ['', `**${name}** output (last lines)`, fenced(c.tail)]);
}

const paths = (list) => list.map((p) => `\`${p}\``).join(', ');

function conformanceSection(c) {
  if (!c) return [];
  const lines = ['', '## Plan conformance', `- ${c.touchedPlanned} of ${c.planned} planned files changed`];
  if (c.checked > 0) lines.push(`- ${c.identical.length} of ${c.checked} files with plan code are identical`);
  if (c.differs.length) lines.push(`- Differs from the plan: ${paths(c.differs)}`);
  if (c.missing.length) lines.push(`- Planned but not changed: ${paths(c.missing)}`);
  if (c.unexpected.length) lines.push(`- Not in the plan: ${paths(c.unexpected)}`);
  return lines;
}

const bullets = (items) => items.map((x) => `- ${x}`).join('\n');

const runLink = (v, runUrl) =>
  `[Run log and artifacts](${runUrl})${v.artifacts?.files ? ` · artifacts collected (${v.artifacts.files} files)` : ''}`;

export function renderPrBody(v) {
  const r = v.report;
  return [
    taskMarker({ plan: v.plan, task: v.task, issue: v.issue }),
    `Closes #${v.issue}`,
    '',
    `**Task ${v.task}: ${v.taskTitle}** — \`${v.plan}\``,
    `Base: \`${v.baseBranch}\` · Model: \`${v.model}\` · Commits: ${v.commits}`,
    '',
    '## Summary',
    r.summary,
    '',
    '## Checks (run by the harness)',
    checkTable(v.checks),
    ...(v.artifacts?.files ? ['', `Artifacts: ${v.artifacts.files} files collected in the run artifact.`] : []),
    ...conformanceSection(v.conformance),
    ...(v.warnings.length ? ['', '## Warnings', bullets(v.warnings)] : []),
    '',
    '## Self-review',
    r.selfReview,
    '',
    '## Known issues',
    r.knownIssues,
    '',
    '<details><summary>Agent report</summary>',
    '',
    '~~~',
    (v.reportText ?? '').trim(),
    '~~~',
    '',
    '</details>',
  ].join('\n');
}

export function renderComment(v, { runUrl, prUrl } = {}) {
  if (v.outcome === 'READY_FOR_QA') {
    return `✅ **READY_FOR_QA** — ${prUrl ?? 'PR opened'}\n\n${runLink(v, runUrl)}`;
  }
  if (v.outcome === 'WAITING') {
    return [
      `⏸️ **WAITING** (${v.kind})`,
      '',
      bullets(v.reasons),
      '',
      'The queue is paused. A scheduled run resumes it automatically once an account has usage again.',
      '',
      runLink(v, runUrl),
    ].join('\n');
  }
  const lines = [`⛔ **BLOCKED** (${v.kind})`, '', bullets(v.reasons)];
  const r = v.report;
  if (r?.status === 'BLOCKED') {
    lines.push('', '**Evidence**', '~~~', r.evidence, '~~~', '', '**Required human action**', r.requiredHumanAction);
  }
  if (v.checks && Object.keys(v.checks).length) lines.push('', checkTable(v.checks), ...checkTails(v.checks));
  if (v.warnings?.length) lines.push('', '**Warnings**', bullets(v.warnings));
  if (v.commits > 0) lines.push('', `The attempt was pushed to \`${v.branch}\` for inspection.`);
  lines.push('', runLink(v, runUrl), '', 'To retry: remove `agent:blocked` and add `agent`.');
  return lines.join('\n');
}
