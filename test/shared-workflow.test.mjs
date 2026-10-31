import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintNeutralNames, lintEnvExpressions } from '../harness/lib/neutral.mjs';

const root = join(import.meta.dirname, '..');
const wf = readFileSync(join(root, '.github/workflows/run-shared.yml'), 'utf8');
const caller = readFileSync(join(root, 'templates/runner.yml'), 'utf8');
const clone = readFileSync(join(root, 'harness/shared-clone.sh'), 'utf8');
const steps = wf.split(/\n      - /).slice(1);

test('names, groups and artifact names carry only indices', () => {
  assert.deepEqual(lintNeutralNames(wf), []);
  assert.deepEqual(lintNeutralNames(caller), []);
});

test('no step prints project data through an env value (C2)', () => {
  assert.deepEqual(lintEnvExpressions(wf), []);
  assert.deepEqual(lintEnvExpressions(caller), []);
});

test('every encrypt and decrypt binds the file to its run (and index for run output) (M6)', () => {
  const lines = wf.split('\n').filter((l) => /cli\.mjs (encrypt|decrypt)/.test(l));
  assert.equal(lines.length, 5, 'one encrypt in select, decrypt and encrypt in run, two decrypts in publish');
  for (const l of lines) assert.match(l, /--aad "/, l);
});

test('the caller can only be started by the schedule or by the owner, and reacts to nothing else', () => {
  assert.match(caller, /^on:\n  workflow_dispatch:\n(?:  #.*\n)*  schedule:/m);
  assert.ok(!/^\s+(issues|pull_request|pull_request_target|issue_comment|push):/m.test(caller));
  // The next round is started by the workflow's own token, whose actor is the Actions bot.
  assert.match(caller, /github\.event_name == 'schedule' \|\| github\.actor == github\.repository_owner \|\| github\.actor == 'github-actions\[bot\]'/);
});

// Step-scoped env keeps a secret out of other steps' environment variables. It does not keep it
// out of the job's memory: see the shared-runner spec, "What project code in the run job can reach".
test('the agent step is not given the tokens, the key or the store', () => {
  const agent = steps.filter((s) => /run-task\.mjs/.test(s));
  assert.equal(agent.length, 1);
  assert.ok(!/RUNNER_TOKENS|RUN_KEY|STORE_/.test(agent[0]));
  assert.match(agent[0], /CLAUDE_CODE_OAUTH_TOKEN/);
});

test('the runner repository only ever needs read access for its own token', () => {
  const perms = [...wf.matchAll(/permissions:\n((?:      +\w[\w-]*: \w+\n)+)/g)].map((m) => m[1]);
  assert.ok(perms.length >= 4);
  for (const p of perms) assert.ok(!/(contents|issues|pull-requests): write/.test(p), p);
});

test('publish decides from its own output, not from the aggregated result of the whole matrix (review focus 4)', () => {
  assert.ok(!/needs\.run\.result/.test(wf), 'needs.run.result aggregates every project');
  const publish = steps.find((s) => /Publish result/.test(s));
  assert.match(publish, /verdict\.json/);
});

test('publish.sh output and errors go to a file, never to the public log (review focus 5)', () => {
  const publish = steps.find((s) => /Publish result/.test(s));
  assert.match(publish, /publish\.sh >"\$RUNNER_TEMP\/publish\.log" 2>&1/);
});

test('the clone script keeps the token out of URLs, config and the log, and silences git errors', () => {
  assert.ok(!/set -x|set -o xtrace/.test(clone));
  assert.ok(!/x-access-token:\$\{?token/.test(clone), 'no token in a URL');
  assert.match(clone, /extraheader/);
  assert.match(clone, /::add-mask::/);
  assert.ok(!/git config --global|credential\.helper/.test(clone));
  const gitLines = clone.split('\n').filter((l) => /^\s*git /.test(l) || /\bgit -c /.test(l));
  assert.ok(gitLines.length >= 4);
  for (const l of gitLines) assert.match(l, /2>\/dev\/null/, l);
});

test('publish and continue only run after a select that succeeded (M1)', () => {
  const publish = wf.slice(wf.indexOf('\n  publish:'), wf.indexOf('\n  continue:'));
  assert.match(publish, /if: always\(\) && needs\.select\.result == 'success' && needs\.select\.outputs\.count != '0'/);
  const job = wf.slice(wf.indexOf('\n  continue:'));
  assert.match(job, /needs\.select\.result == 'success'/);
});

test('the continue job needs only the right to start a workflow', () => {
  const job = wf.slice(wf.indexOf('\n  continue:'));
  assert.match(job, /actions: write/);
  assert.ok(!/contents: write|issues: write|pull-requests: write/.test(job));
});
