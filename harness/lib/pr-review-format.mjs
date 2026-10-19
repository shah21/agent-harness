// A pull request review as a short block in the issue body: verdict, one line per confirmed finding,
// everything else folded.
import { REVIEW_MARKER, requestText } from './pr-review.mjs';
import { actionable } from './review.mjs';

const BODY_LIMIT = 60000;
const HEADINGS = { changes: '🔴 Changes requested', comments: '🟡 Comments', clean: '🟢 Looks good' };
const ICONS = { high: '🔴', medium: '🟡' };

const cut = (text, max = 160) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function where(prs, f) {
  const pr = prs.filter((p) => f.file.startsWith(p.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  const rel = pr ? f.file.slice(pr.prefix.length) : f.file;
  const label = `\`${rel}${f.line ? `:${f.line}` : ''}\``;
  return pr ? `[${label}](https://github.com/${pr.repo}/blob/${pr.headSha}/${rel}${f.line ? `#L${f.line}` : ''})` : label;
}

function parts(v, { runUrl } = {}) {
  const findings = v.review.findings;
  const confirmed = actionable(findings);
  const counts = ['high', 'medium']
    .map((s) => [s, confirmed.filter((f) => f.severity === s).length])
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`);
  const low = findings.filter((f) => f.severity === 'low');
  const gone = findings.filter((f) => f.verification === 'WITHDRAWN');
  const warnings = v.warnings ?? [];
  return {
    head: [
      REVIEW_MARKER,
      `## ${[HEADINGS[v.review.verdict], ...counts].join(' · ')}`,
      v.prs.map((p) => `\`${p.repo}#${p.number}\` @ ${p.headSha.slice(0, 7)}`).join(' · '),
      ...(confirmed.length ? ['', ...confirmed.map((f) => `- ${ICONS[f.severity]} ${where(v.prs, f)} ${cut(f.problem)}${f.fix ? ` **Fix:** ${cut(f.fix)}` : ''}`)] : []),
    ],
    folded: [
      ...low.map((f) => `- low ${where(v.prs, f)} ${cut(f.problem)}`),
      ...gone.map((f) => `- withdrawn ${where(v.prs, f)} ${cut(f.problem)} Evidence: ${cut(f.evidence)}`),
      ...warnings.map((w) => `- warning: ${cut(w, 300)}`),
    ],
    summary: [
      low.length && `${low.length} low`,
      gone.length && `${gone.length} withdrawn`,
      warnings.length && `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · '),
    tail: `<sub>${v.model}${runUrl ? ` · [run](${runUrl})` : ''}</sub>`,
    cutNote: false,
  };
}

function compose(p) {
  const fold = p.folded.length
    ? ['', `<details><summary>${p.summary}${p.cutNote ? ' (cut)' : ''}</summary>`, '', ...p.folded, '', '</details>']
    : [];
  return [...p.head, ...fold, '', p.tail].join('\n');
}

export const renderPrReview = (v, opts) => compose(parts(v, opts));

// Keeps the request above the marker and replaces any earlier review; folded lines go first when too long.
export function mergeIssueBody(current, v, opts = {}) {
  const request = requestText(current).trimEnd();
  const room = BODY_LIMIT - request.length - 3;
  const p = parts(v, opts);
  let section = compose(p);
  while (section.length > room && p.folded.length) {
    p.folded.length = Math.floor(p.folded.length * 0.8);
    p.cutNote = true;
    section = compose(p);
  }
  if (section.length > room) section = `${section.slice(0, room - 20)}\n\n[truncated]`;
  return `${request}\n\n${section}\n`;
}

export function renderReviewBlocked(v, { runUrl } = {}) {
  return [
    `⛔ **BLOCKED** (${v.kind})`, '', ...v.reasons.map((r) => `- ${r}`), '', `[Run log and artifacts](${runUrl})`, '',
    'To retry: remove `agent:blocked` and add `review`.',
  ].join('\n');
}
