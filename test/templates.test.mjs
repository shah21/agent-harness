import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the close-merged caller runs only for merged same-repo agent PRs, in its own workflow', () => {
  const y = read('templates/close-merged.yml');
  assert.match(y, /pull_request:\s*\n\s*types: \[closed\]/);
  assert.match(y, /github\.event\.pull_request\.merged == true/);
  assert.match(y, /startsWith\(github\.event\.pull_request\.head\.ref, 'agent\/issue-'\)/);
  assert.match(y, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(y, /concurrency:/, 'must not share the agent queue concurrency group');
  assert.match(y, /issues: write/);
  assert.match(y, /agent-harness\/\.github\/workflows\/close-merged\.yml@v1/);
});

test('the reusable close-merged workflow only has the permissions it needs and closes as completed', () => {
  const y = read('.github/workflows/close-merged.yml');
  assert.match(y, /workflow_call:/);
  assert.match(y, /issues: write/);
  assert.match(y, /contents: read/);
  assert.doesNotMatch(y, /contents: write|pull-requests: write/);
  assert.match(y, /gh issue close .*--reason completed/);
  assert.match(y, /cli\.mjs merged-issue/);
});
