import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrBody, renderComment, renderTargetPr } from '../harness/lib/format.mjs';
import { parseTaskMarker } from '../harness/lib/queue.mjs';
import { parseTargetsMarker, RELATED_TOKEN } from '../harness/lib/target.mjs';

const readyVerdict = {
  outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings: ['dependency files changed: package.json'],
  issue: 7, issueTitle: 'Task 1', plan: 'docs/p.md', task: 1, taskTitle: 'Add greeting',
  baseBranch: 'main', branch: 'agent/issue-7', model: 'sonnet', commits: 2,
  checks: { test: { ok: true, exitCode: 0, timedOut: false, durationSec: 3 } },
  report: { summary: 'Added greeting.', selfReview: 'Scoped.', knownIssues: 'None' },
  reportText: 'STATUS: READY_FOR_QA\n',
};

test('PR body carries the marker, issue link, checks and warnings', () => {
  const body = renderPrBody(readyVerdict);
  assert.deepEqual(parseTaskMarker(body), { plan: 'docs/p.md', task: 1, issue: 7 });
  assert.match(body, /Closes #7/);
  assert.match(body, /\| test \| PASS \|/);
  assert.match(body, /## Warnings\n- dependency files changed: package\.json/);
  assert.match(body, /Added greeting\./);
});

test('ready comment links the PR and the run', () => {
  const c = renderComment(readyVerdict, { runUrl: 'https://run', prUrl: 'https://pr' });
  assert.match(c, /READY_FOR_QA/);
  assert.match(c, /https:\/\/pr/);
  assert.match(c, /https:\/\/run/);
});

test('blocked comment from the agent shows evidence, action, checks and branch', () => {
  const c = renderComment({
    ...readyVerdict, outcome: 'BLOCKED', kind: 'report', reasons: ['No secret.'], warnings: [], commits: 1,
    checks: { test: { ok: false, exitCode: null, timedOut: true, durationSec: 600 } },
    report: { status: 'BLOCKED', evidence: '$ echo $KEY', requiredHumanAction: 'Set KEY.' },
  }, { runUrl: 'https://run' });
  assert.match(c, /BLOCKED\*\* \(report\)/);
  assert.match(c, /- No secret\./);
  assert.match(c, /\$ echo \$KEY/);
  assert.match(c, /Set KEY\./);
  assert.match(c, /\| test \| TIMEOUT \|/);
  assert.match(c, /pushed to `agent\/issue-7`/);
  assert.match(c, /remove `agent:blocked` and add `agent`/);
});

test('blocked comment without a report or commits stays short', () => {
  const c = renderComment({ ...readyVerdict, outcome: 'BLOCKED', kind: 'gate', reasons: ['base is red: test failed before the agent started'], warnings: [], commits: 0, checks: {}, report: null }, { runUrl: 'https://run' });
  assert.doesNotMatch(c, /Evidence/);
  assert.doesNotMatch(c, /pushed to/);
  assert.match(c, /base is red/);
});

test('waiting comment explains the pause and automatic resume', () => {
  const c = renderComment({ ...readyVerdict, outcome: 'WAITING', kind: 'usage-limit', reasons: ['usage limit reached on all 2 Claude accounts'], warnings: [], commits: 0, checks: {}, report: null }, { runUrl: 'https://run' });
  assert.match(c, /WAITING/);
  assert.match(c, /usage limit reached on all 2 Claude accounts/);
  assert.match(c, /resume/i);
  assert.doesNotMatch(c, /To retry/);
});

test('collected artifacts are mentioned in the comment and the PR body', () => {
  const v = { ...readyVerdict, artifacts: { files: 3, bytes: 100, skipped: 0 } };
  assert.match(renderComment(v, { runUrl: 'https://run', prUrl: 'https://pr' }), /\[Run log and artifacts\]\(https:\/\/run\) · artifacts collected \(3 files\)/);
  assert.match(renderPrBody(v), /Artifacts: 3 files collected in the run artifact\./);
  const blockedV = { ...v, outcome: 'BLOCKED', kind: 'gate', reasons: ['x'], report: null, commits: 0 };
  assert.match(renderComment(blockedV, { runUrl: 'https://run' }), /artifacts collected \(3 files\)/);
});

test('no artifacts → no artifacts line', () => {
  assert.doesNotMatch(renderComment(readyVerdict, { runUrl: 'https://run', prUrl: 'https://pr' }), /artifacts collected/);
  assert.doesNotMatch(renderPrBody({ ...readyVerdict, artifacts: { files: 0, bytes: 0, skipped: 0 } }), /Artifacts:/);
});

test('blocked comment shows the output of each failing check, and only failing ones', () => {
  const c = renderComment({
    ...readyVerdict, outcome: 'BLOCKED', kind: 'gate', reasons: ['base is red: typecheck failed before the agent started'], warnings: [], commits: 0, report: null,
    checks: {
      test: { ok: true, exitCode: 0, timedOut: false, durationSec: 2 },
      typecheck: { ok: false, exitCode: 2, timedOut: false, durationSec: 4, tail: "src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'." },
    },
  }, { runUrl: 'https://run' });
  assert.match(c, /\| typecheck \| FAIL \(exit 2\) \|/);
  assert.match(c, /\*\*typecheck\*\* output \(last lines\)/);
  assert.match(c, /error TS2304: Cannot find name 'LayoutProps'\./);
  assert.doesNotMatch(c, /\*\*test\*\* output/);
});

test('a failing check whose output contains a ~~~ fence cannot break out of the block', () => {
  const c = renderComment({
    ...readyVerdict, outcome: 'BLOCKED', kind: 'gate', reasons: ['x'], warnings: [], commits: 0, report: null,
    checks: { test: { ok: false, exitCode: 1, timedOut: false, durationSec: 1, tail: 'before\n~~~\n**injected**\n~~~~~\nafter' } },
  }, { runUrl: 'https://run' });
  const lines = c.split('\n');
  const heading = lines.findIndex((l) => l.includes('**test** output'));
  const fence = lines[heading + 1];
  assert.match(fence, /^~{6}$/, 'fence is one longer than the longest tilde run in the output');
  assert.equal(lines.filter((l) => l === fence).length, 2, 'exactly one opening and one closing fence');
  assert.ok(c.includes('**injected**'), 'the output is still there');
});

test('failing checks without captured output add no output block', () => {
  const c = renderComment({
    ...readyVerdict, outcome: 'BLOCKED', kind: 'gate', reasons: ['x'], warnings: [], commits: 0, report: null,
    checks: { test: { ok: false, exitCode: 1, timedOut: false, durationSec: 1 } },
  }, { runUrl: 'https://run' });
  assert.doesNotMatch(c, /output \(last lines\)/);
});

test('PR body summarises plan conformance and names the exceptions', () => {
  const body = renderPrBody({ ...readyVerdict, conformance: { identical: ['a.ts'], differs: ['b.ts'], missing: ['m.ts'], unexpected: ['u.ts'], planned: 3, touchedPlanned: 2, checked: 2 } });
  assert.match(body, /## Plan conformance/);
  assert.match(body, /2 of 3 planned files changed/);
  assert.match(body, /1 of 2 files with plan code are identical/);
  assert.match(body, /Differs from the plan: `b\.ts`/);
  assert.match(body, /Planned but not changed: `m\.ts`/);
  assert.match(body, /Not in the plan: `u\.ts`/);
});

test('PR body shows a clean conformance line and omits the section when there is none', () => {
  const clean = renderPrBody({ ...readyVerdict, conformance: { identical: ['a.ts', 'b.ts'], differs: [], missing: [], unexpected: [], planned: 2, touchedPlanned: 2, checked: 2 } });
  assert.match(clean, /2 of 2 planned files changed/);
  assert.match(clean, /2 of 2 files with plan code are identical/);
  assert.doesNotMatch(clean, /Differs from the plan/);
  assert.doesNotMatch(renderPrBody(readyVerdict), /Plan conformance/);
});

const prArgs = {
  titleTemplate: 'Task {task}: {taskTitle}', bodyTemplate: null, issue: 7, task: 3, taskTitle: 'feat: Add picker',
  report: { summary: 'Added picker.' }, checks: { test: { ok: true }, lint: { ok: true } }, changedFiles: ['src/a.ts'],
};

test('target PR default text has no harness marker or issue link', () => {
  const { prTitle, prBody } = renderTargetPr(prArgs);
  assert.equal(prTitle, 'Task 3: Add picker');
  assert.match(prBody, /## Summary\nAdded picker\./);
  assert.match(prBody, /## Changed files\n- `src\/a\.ts`/);
  assert.match(prBody, /## Checks\n- test: PASS\n- lint: PASS/);
  assert.ok(prBody.includes(RELATED_TOKEN));
  assert.doesNotMatch(prBody, /agent-task|Closes #/);
});

test('target PR uses the consumer templates', () => {
  const { prTitle, prBody } = renderTargetPr({ ...prArgs, titleTemplate: '{taskTitle}', bodyTemplate: 'Why: {summary}\n{related}' });
  assert.equal(prTitle, 'Add picker');
  assert.equal(prBody, `Why: Added picker.\n${RELATED_TOKEN}`);
  assert.throws(() => renderTargetPr({ ...prArgs, bodyTemplate: '{oops}' }), /unknown variable \{oops\}/);
});

const targetPrs = [
  { repo: 'o/sub', number: 45, url: 'https://github.com/o/sub/pull/45', branch: 'feat/x', base: 'main', role: 'sub' },
  { repo: 'o/super', number: 123, url: 'https://github.com/o/super/pull/123', branch: 'feat/x', base: 'main', role: 'super' },
];

test('ready comment with target PRs lists them and carries the marker', () => {
  const c = renderComment(readyVerdict, { runUrl: 'https://run', targetPrs });
  assert.match(c, /^✅ \*\*READY_FOR_QA\*\* — https:\/\/github\.com\/o\/super\/pull\/123/);
  assert.match(c, /- `o\/sub` #45 \(draft\): https:\/\/github\.com\/o\/sub\/pull\/45/);
  assert.deepEqual(parseTargetsMarker(c), targetPrs.map(({ url, ...rest }) => rest));
});

test('blocked comment with targets reports consumer pushes and unpushed targets', () => {
  const v = {
    ...readyVerdict, outcome: 'BLOCKED', kind: 'gate', reasons: ['x'], report: null, checks: {}, warnings: [],
    commits: 3, consumerCommits: 0, targets: [{ repo: 'o/super', commits: 3 }],
  };
  const c = renderComment(v, { runUrl: 'https://run' });
  assert.doesNotMatch(c, /pushed to `agent\/issue-7`/);
  assert.match(c, /Changes to the target repositories were not pushed; their bundles are in the run artifact\./);
});
