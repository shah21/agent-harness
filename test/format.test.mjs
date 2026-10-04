import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrBody, renderComment } from '../harness/lib/format.mjs';
import { parseTaskMarker } from '../harness/lib/queue.mjs';

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
