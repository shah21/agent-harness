import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueToClose } from '../harness/lib/merged.mjs';
import { taskMarker } from '../harness/lib/queue.mjs';

const body = (issue) => `${taskMarker({ plan: 'docs/p.md', task: 2, issue })}\nCloses #${issue}\n`;
const event = (over = {}) => ({
  pull_request: {
    merged: true,
    head: { ref: 'agent/issue-12', repo: { full_name: 'o/r' } },
    base: { ref: 'agent/issue-9', repo: { full_name: 'o/r' } },
    body: body(12),
    ...over,
  },
});

test('a merged agent PR closes the issue named by its marker, whatever its base branch', () => {
  assert.equal(issueToClose(event()), 12);
  assert.equal(issueToClose(event({ base: { ref: 'main', repo: { full_name: 'o/r' } } })), 12);
});

test('a PR that was closed without merging closes nothing', () => {
  assert.equal(issueToClose(event({ merged: false })), null);
});

test('only agent/issue-<n> branches count', () => {
  for (const ref of ['feat/x', 'agent/issue-12-extra', 'xagent/issue-12', 'agent/issue-']) {
    assert.equal(issueToClose(event({ head: { ref, repo: { full_name: 'o/r' } } })), null, ref);
  }
});

test('a fork PR is ignored even if it copies the branch name and marker', () => {
  assert.equal(issueToClose(event({ head: { ref: 'agent/issue-12', repo: { full_name: 'evil/r' } } })), null);
  assert.equal(issueToClose(event({ head: { ref: 'agent/issue-12', repo: null } })), null);
});

test('the marker must name the same issue as the branch, and must exist', () => {
  assert.equal(issueToClose(event({ body: body(99) })), null);
  assert.equal(issueToClose(event({ body: 'Closes #12' })), null);
  assert.equal(issueToClose(event({ body: null })), null);
});

test('a malformed event closes nothing and never throws', () => {
  assert.equal(issueToClose({}), null);
  assert.equal(issueToClose(null), null);
  assert.equal(issueToClose({ pull_request: {} }), null);
});
