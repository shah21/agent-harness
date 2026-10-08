import { taskMarker } from './queue.mjs';
import { fill, splitTaskType, RELATED_TOKEN, targetsMarker } from './target.mjs';

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

const DEFAULT_TARGET_BODY = '## Summary\n{summary}\n\n## Changed files\n{changedFiles}\n\n## Checks\n{checks}\n\n{related}\n';

export function renderTargetPr({ titleTemplate, bodyTemplate, issue, task, taskTitle, report, checks, changedFiles }) {
  const vars = {
    issue: String(issue),
    task: String(task),
    taskTitle: splitTaskType(taskTitle).title,
    summary: report.summary,
    changedFiles: changedFiles.map((p) => `- \`${p}\``).join('\n') || '- (none)',
    checks: Object.entries(checks ?? {}).map(([name, c]) => `- ${name}: ${c.ok ? 'PASS' : 'FAIL'}`).join('\n'),
    related: RELATED_TOKEN,
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
