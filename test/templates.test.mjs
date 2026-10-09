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

const step = (yaml, name) => {
  const start = yaml.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `step "${name}" missing`);
  const next = yaml.indexOf('\n      - name:', start + 1);
  return yaml.slice(start, next === -1 ? undefined : next);
};

test('target secrets are optional workflow_call secrets', () => {
  const y = read('.github/workflows/run-task.yml');
  assert.match(y, /TARGET_READ_TOKEN:\n\s+required: false/);
  assert.match(y, /TARGET_PUSH_TOKEN:\n\s+required: false/);
});

test('the Run task step carries no target secret', () => {
  const y = read('.github/workflows/run-task.yml');
  assert.doesNotMatch(step(y, 'Run task'), /TARGET_/);
  assert.match(step(y, 'Run task'), /--selection "\$RUNNER_TEMP\/agent\/selection\.json"/);
});

test('the target checkout uses the read token without persisting it and records failure', () => {
  const y = read('.github/workflows/run-task.yml');
  const s = step(y, 'Checkout target');
  assert.match(s, /token: \$\{\{ secrets\.TARGET_READ_TOKEN \}\}/);
  assert.match(s, /persist-credentials: false/);
  assert.match(s, /submodules: recursive/);
  assert.match(s, /continue-on-error: true/);
  assert.match(step(y, 'Record target checkout failure'), /target checkout failed/);
});

test('publish gets the push token and the bundle directory; select closes merged target tasks', () => {
  const y = read('.github/workflows/run-task.yml');
  const p = step(y, 'Publish result');
  assert.match(p, /TARGET_PUSH_TOKEN: \$\{\{ secrets\.TARGET_PUSH_TOKEN \}\}/);
  assert.match(p, /BUNDLE_DIR/);
  const c = step(y, 'Close tasks whose target PR merged');
  assert.match(c, /\[ -n "\$TARGET_TOKEN" \] \|\| exit 0/);
  assert.match(c, /targets-to-check/);
  assert.match(c, /--reason completed/);
  assert.match(step(y, 'Select next task'), /--ready /);
});

test('the caller template mentions the target secrets only as comments', () => {
  const y = read('templates/agent.yml');
  assert.match(y, /# TARGET_READ_TOKEN: \$\{\{ secrets\.TARGET_READ_TOKEN \}\}/);
  assert.match(y, /# TARGET_PUSH_TOKEN: \$\{\{ secrets\.TARGET_PUSH_TOKEN \}\}/);
});

test('the debug workflow gives the run job no write token and publishes without touching branches', () => {
  const y = read('.github/workflows/run-debug.yml');
  assert.match(y, /workflow_call:/);
  const run = y.slice(y.indexOf('\n  run:'), y.indexOf('\n  publish:'));
  assert.match(run, /contents: read/);
  assert.doesNotMatch(run, /issues: write|contents: write|pull-requests: write|TARGET_PUSH_TOKEN/);
  assert.match(run, /fetch-depth: 0/);
  assert.match(y, /debug-run\.mjs/);
  assert.match(y, /publish-debug\.sh/);
  assert.doesNotMatch(y, /pull-requests: write|contents: write/);
});

test('the caller template runs the debug job after the agent job', () => {
  const y = read('templates/agent.yml');
  assert.match(y, /\n  debug:\n    needs: agent\n/);
  assert.match(y, /github\.event\.label\.name == 'debug'/);
  assert.match(y, /run-debug\.yml@v1/);
});
