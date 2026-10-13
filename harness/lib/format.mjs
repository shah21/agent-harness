import { taskMarker } from './queue.mjs';
import { fill, splitTaskType, RELATED_TOKEN, targetsMarker } from './target.mjs';
import { actionable, SEVERITIES } from './review.mjs';

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

const COMMENT_LIMIT = 60000;
const capComment = (text) => (text.length < COMMENT_LIMIT ? text : `${text.slice(0, COMMENT_LIMIT - 100)}\n\n[truncated]`);
const where = (f) => (f.line ? `${f.file}:${f.line}` : f.file);
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = (sha) => sha.slice(0, 7);

const EXIT_TEXT = {
  clean: 'no high or medium findings left',
  'max-rounds': 'round limit reached',
  'no-progress': 'the same findings came back',
  'fix-broke-checks': 'a fix broke the checks and was reverted',
  gate: 'a fix broke a harness rule and was reverted',
  budget: 'review time budget used up',
  'usage-limit': 'Claude usage limit reached',
  'reviewer-error': 'the review could not be completed',
};

function resultCell(f, round) {
  const reply = round.fixes?.find((x) => x.id === f.id);
  if (!reply) return '—';
  if (round.reverted) return 'REVERTED';
  if (reply.result === 'WONTFIX') return `WONTFIX: ${reply.reason}`;
  if (reply.result !== 'FIXED') return reply.result;
  const shas = [round.commit, ...Object.values(round.targets ?? {})].filter(Boolean).map(short);
  return shas.length ? `FIXED (${shas.join(', ')})` : 'FIXED';
}

const openLine = (f) => `- ${f.id} ${f.severity} \`${where(f)}\` ${f.rule}: ${f.problem}${f.result ? ` (${f.result}${f.reason ? `: ${f.reason}` : ''})` : ''}`;

export function renderReviewRound(round) {
  const counts = SEVERITIES.map((s) => `${round.findings.filter((f) => f.severity === s).length} ${s}`).join(', ');
  const act = actionable(round.findings);
  const low = round.findings.filter((f) => f.severity === 'low');
  const lines = [`<!-- agent-review round=${round.n} -->`, `### Review round ${round.n} — ${counts}`, ''];
  if (act.length) {
    lines.push('| id | sev | file | rule | problem | result |', '|---|---|---|---|---|---|',
      ...act.map((f) => `| ${f.id} | ${f.severity} | \`${cell(where(f))}\` | ${cell(f.rule)} | ${cell(f.problem)} | ${cell(resultCell(f, round))} |`));
  } else {
    lines.push('No high or medium findings.');
  }
  if (round.reverted) {
    lines.push('', '**Reverted:** the fix was discarded; the branch is back on the last state whose checks passed.', ...checkTails(round.checks));
  } else if (round.checks && Object.keys(round.checks).length) {
    lines.push('', `Checks after fix: ${Object.entries(round.checks).map(([name, c]) => `${c.ok ? '✅' : '❌'} ${name}`).join(' ')}`);
  }
  if (low.length) {
    lines.push('', `<details><summary>${low.length} low (not fixed)</summary>`, '', ...low.map((f) => `- \`${where(f)}\` ${f.rule}: ${f.problem}`), '', '</details>');
  }
  return capComment(lines.join('\n'));
}

export function renderReviewSummary(review) {
  const lines = [
    '<!-- agent-review summary -->',
    `### Review summary — ${review.exit}`,
    '',
    `Stopped: ${EXIT_TEXT[review.exit]}. Rounds: ${review.rounds.length}. Model: \`${review.model}\`.`,
  ];
  if (review.error) lines.push('', `Error: ${review.error}`);
  if (review.open.length) lines.push('', `**Open findings (${review.open.length})** — review them before merging:`, ...review.open.map(openLine));
  else lines.push('', 'No open findings.');
  return capComment(lines.join('\n'));
}

function reviewSection(review) {
  if (!review) return [];
  return [
    '', '## Review',
    `Stopped: ${EXIT_TEXT[review.exit]}. Rounds: ${review.rounds.length}.`,
    ...(review.open.length ? ['Open findings:', ...review.open.map(openLine)] : ['No open findings.']),
  ];
}

export function reviewLine(review) {
  if (!review) return '';
  const rounds = `${review.rounds.length} round${review.rounds.length === 1 ? '' : 's'}`;
  if (!review.open.length) return `Review: no open findings (${rounds}).`;
  const n = review.open.length;
  return `Review: ${n} open finding${n === 1 ? '' : 's'} — ${review.open.map((f) => `${f.severity} \`${where(f)}\` ${f.rule}`).join('; ')}`;
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
    ...reviewSection(v.review),
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

const DEFAULT_TARGET_BODY = '## Summary\n{summary}\n\n## Changed files\n{changedFiles}\n\n## Checks\n{checks}\n\n{related}\n';

export function renderTargetPr({ titleTemplate, bodyTemplate, issue, task, taskTitle, report, checks, changedFiles, review = null }) {
  const vars = {
    issue: String(issue),
    task: String(task),
    taskTitle: splitTaskType(taskTitle).title,
    summary: report.summary,
    changedFiles: changedFiles.map((p) => `- \`${p}\``).join('\n') || '- (none)',
    checks: Object.entries(checks ?? {}).map(([name, c]) => `- ${name}: ${c.ok ? 'PASS' : 'FAIL'}`).join('\n'),
    related: RELATED_TOKEN,
    review: reviewLine(review),
  };
  return { prTitle: fill(titleTemplate, vars), prBody: fill(bodyTemplate ?? DEFAULT_TARGET_BODY, vars) };
}

export function renderComment(v, { runUrl, prUrl, targetPrs } = {}) {
  if (v.outcome === 'READY_FOR_QA') {
    // Target PRs stay in code spans: a link from the queue repo adds a "mentioned this" event to them.
    const superUrl = targetPrs?.find((p) => p.role === 'super')?.url;
    const main = prUrl ?? (superUrl ? `\`${superUrl}\`` : 'PR opened');
    const head = `✅ **READY_FOR_QA** — ${main}\n\n${runLink(v, runUrl)}`;
    if (!targetPrs?.length) return head;
    const list = targetPrs.map((p) => `- \`${p.repo}#${p.number}\` (draft): \`${p.url}\``).join('\n');
    const marker = targetsMarker(targetPrs.map(({ repo, number, branch, base, role }) => ({ repo, number, branch, base, role })));
    return `${head}\n\n${list}\n\n${marker}`;
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
  const pushed = v.targets ? v.consumerCommits : v.commits;
  if (pushed > 0) lines.push('', `The attempt was pushed to \`${v.branch}\` for inspection.`);
  if (v.targets?.some((t) => t.commits > 0)) lines.push('', 'Changes to the target repositories were not pushed; their bundles are in the run artifact.');
  lines.push('', runLink(v, runUrl), '', 'To retry: remove `agent:blocked` and add `agent`.');
  return lines.join('\n');
}
