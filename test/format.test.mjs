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
