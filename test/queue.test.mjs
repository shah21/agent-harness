import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNext, taskMarker, parseTaskMarker } from '../harness/lib/queue.mjs';

const issue = (number, task, labels, plan = 'docs/p.md') => ({
  number,
  title: `T${task}`,
  body: task == null ? 'no reference here' : `plan: ${plan}\ntask: ${task}`,
  labels: labels.map((name) => ({ name })),
});
const select = (issues, prs = []) => selectNext({ issues, prs, defaultBranch: 'main' });
const pr = (head, plan, task, issueNo) => ({ headRefName: head, body: `x\n${taskMarker({ plan, task, issue: issueNo })}` });

test('returns null when nothing is queued', () => {
  assert.deepEqual(select([issue(1, 1, ['agent:ready'])]), { issue: null });
});

test('orders by plan then task, not by issue number', () => {
  assert.equal(select([issue(5, 2, ['agent']), issue(9, 1, ['agent'])]).issue.number, 9);
  assert.equal(select([issue(1, 1, ['agent'], 'docs/b.md'), issue(2, 5, ['agent'], 'docs/a.md')]).issue.number, 2);
});

test('ignores issues already running', () => {
  assert.equal(select([issue(1, 1, ['agent', 'agent:running']), issue(2, 2, ['agent'])]).issue.number, 2);
});

test('bad references run first and carry a skip reason', () => {
  const s = select([issue(3, 1, ['agent']), issue(4, null, ['agent'])]);
  assert.equal(s.issue.number, 4);
  assert.match(s.skip, /^bad task reference: /);
});

test('stacks on the open agent PR of the highest earlier task in the same plan', () => {
  const prs = [
    pr('agent/issue-1', 'docs/p.md', 1, 1),
    pr('agent/issue-2', 'docs/p.md', 2, 2),
    pr('agent/issue-8', 'docs/other.md', 2, 8),
    { headRefName: 'feature/x', body: 'no marker' },
  ];
  const s = select([issue(3, 3, ['agent'])], prs);
  assert.equal(s.base, 'agent/issue-2');
  assert.equal(s.skip, null);
  assert.deepEqual([s.plan, s.task], ['docs/p.md', 3]);
});

test('falls back to the default branch', () => {
  assert.equal(select([issue(3, 3, ['agent'])], [pr('agent/issue-9', 'docs/p.md', 4, 9)]).base, 'main');
});

test('skips when an earlier task of the same plan is blocked', () => {
  const s = select([issue(1, 1, ['agent:blocked']), issue(2, 2, ['agent'])]);
  assert.equal(s.issue.number, 2);
  assert.equal(s.skip, 'upstream task 1 blocked (#1)');
});

test('a blocked task in another plan does not matter', () => {
  assert.equal(select([issue(1, 1, ['agent:blocked'], 'docs/x.md'), issue(2, 2, ['agent'])]).skip, null);
});

test('a re-queued blocked task runs first and is not its own upstream', () => {
  const s = select([issue(1, 1, ['agent', 'agent:blocked']), issue(2, 2, ['agent'])]);
  assert.equal(s.issue.number, 1);
  assert.equal(s.skip, null);
});

test('accepts plain string labels', () => {
  assert.equal(select([{ number: 1, title: 't', body: 'plan: p.md\ntask: 1', labels: ['agent'] }]).issue.number, 1);
});

test('task marker round trip', () => {
  assert.deepEqual(parseTaskMarker(`text\n${taskMarker({ plan: 'a.md', task: 4, issue: 9 })}`), { plan: 'a.md', task: 4, issue: 9 });
  assert.equal(parseTaskMarker('nothing'), null);
});

test('only same-repo agent/issue-<n> PRs can be stacking parents', () => {
  const prs = [
    pr('feature/evil$(id)', 'docs/p.md', 2, 2),
    { ...pr('agent/issue-1', 'docs/p.md', 1, 1), isCrossRepository: true },
    pr('agent/issue-5', 'docs/p.md', 1, 5),
  ];
  assert.equal(select([issue(3, 3, ['agent'])], prs).base, 'agent/issue-5');
});

test('agent:waiting issues count as queued', () => {
  const s = select([issue(2, 2, ['agent']), issue(1, 1, ['agent:waiting'])]);
  assert.equal(s.issue.number, 1);
  assert.equal(s.skip, null);
});
