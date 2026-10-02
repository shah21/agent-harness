import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskRef, findTaskHeading } from '../harness/lib/issue.mjs';

test('parses plan and task lines', () => {
  assert.deepEqual(parseTaskRef('plan: docs/p.md\ntask: 3\n'), { plan: 'docs/p.md', task: 3 });
});

test('tolerates CRLF and surrounding prose', () => {
  assert.deepEqual(
    parseTaskRef('Please run this.\r\n\r\nplan: docs/p.md\r\ntask: 12\r\nThanks'),
    { plan: 'docs/p.md', task: 12 },
  );
});

test('reports missing lines', () => {
  assert.match(parseTaskRef('task: 1').error, /plan:/);
  assert.match(parseTaskRef('plan: docs/p.md').error, /task:/);
  assert.match(parseTaskRef(null).error, /plan:/);
});

test('rejects paths that escape the repository', () => {
  assert.match(parseTaskRef('plan: ../x.md\ntask: 1').error, /relative inside the repo/);
  assert.match(parseTaskRef('plan: docs/../../x.md\ntask: 1').error, /relative inside the repo/);
  assert.match(parseTaskRef('plan: /etc/x.md\ntask: 1').error, /relative inside the repo/);
});

test('findTaskHeading matches the exact task number at ## or ###', () => {
  const plan = '# Plan\n## Task 1: First\n## Task 10: Tenth\n### Task 2: Second\n';
  assert.equal(findTaskHeading(plan, 1), 'First');
  assert.equal(findTaskHeading(plan, 10), 'Tenth');
  assert.equal(findTaskHeading(plan, 2), 'Second');
  assert.equal(findTaskHeading(plan, 3), null);
});
