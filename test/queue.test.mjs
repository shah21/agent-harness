import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNext, taskMarker, parseTaskMarker, targetsToCheck } from '../harness/lib/queue.mjs';
import { targetsMarker } from '../harness/lib/target.mjs';

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

const readyIssue = (number, task, prsList, plan = 'docs/p.md') => ({
  number, body: `plan: ${plan}\ntask: ${task}`, comments: [{ body: `✅ **READY_FOR_QA** — u\n\n${targetsMarker(prsList)}` }],
});
const tp = (branch, extra = []) => [
  ...extra,
  { repo: 'o/super', number: 10, branch, base: 'main', role: 'super' },
];

test('no ready parents leaves the selection without targets', () => {
  const s = selectNext({ issues: [issue(3, 2, ['agent'])], prs: [], defaultBranch: 'main', ready: [] });
  assert.equal('targets' in s, false);
});

test('stacks target bases on the highest earlier ready task of the same plan', () => {
  const ready = [
    readyIssue(1, 1, tp('fix/one')),
    readyIssue(2, 2, tp('fix/two', [{ repo: 'o/sub', number: 4, branch: 'fix/two', base: 'main', role: 'sub' }])),
    readyIssue(8, 2, tp('fix/other'), 'docs/other.md'),
    readyIssue(5, 4, tp('fix/later')),
  ];
  const s = selectNext({ issues: [issue(3, 3, ['agent'])], prs: [], defaultBranch: 'main', ready });
  assert.deepEqual(s.targets, { superBranch: 'fix/two', bases: { 'o/sub': 'fix/two', 'o/super': 'fix/two' } });
});

test('ignores a parent whose marker is unsafe', () => {
  const bad = { number: 2, body: 'plan: docs/p.md\ntask: 2', comments: [{ body: '✅ **READY_FOR_QA** — u\n\n<!-- agent-targets {"prs":[{"repo":"o/super","number":1,"branch":"x; rm -rf /","base":"main","role":"super"}]} -->' }] };
  const s = selectNext({ issues: [issue(3, 3, ['agent'])], prs: [], defaultBranch: 'main', ready: [bad] });
  assert.equal('targets' in s, false);
});

test('targetsToCheck returns each issue\'s superproject PR', () => {
  const ready = [readyIssue(1, 1, tp('fix/one')), { number: 2, body: 'plan: docs/p.md\ntask: 2', comments: [{ body: 'hi' }] }];
  assert.deepEqual(targetsToCheck(ready), [{ issue: 1, repo: 'o/super', number: 10 }]);
});
