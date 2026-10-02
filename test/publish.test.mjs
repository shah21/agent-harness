import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const PUBLISH = new URL('../harness/publish.sh', import.meta.url).pathname;
const STUBS = new URL('./stubs', import.meta.url).pathname;
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

const baseVerdict = {
  outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings: [],
  issue: 7, issueTitle: 'Task 1', plan: 'docs/p.md', task: 1, taskTitle: 'Add greeting',
  baseBranch: 'main', branch: 'agent/issue-7', model: 'sonnet', commits: 1,
  checks: { test: { ok: true, exitCode: 0, timedOut: false, durationSec: 1 } },
  report: { summary: 'Added greeting.', selfReview: 'Scoped.', knownIssues: 'None' },
  reportText: 'STATUS: READY_FOR_QA',
};

function setup(verdict, { bundle = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-'));
  const src = join(dir, 'src');
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: src });
  execFileSync('git', ['init', '-q', '-b', 'agent/issue-7', src]);
  writeFileSync(join(src, 'greeting.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'work');
  // A hook planted by the agent must never run during publishing.
  writeFileSync(join(src, '.git', 'hooks', 'pre-push'), '#!/bin/sh\ntouch "$HOOK_RAN"\n', { mode: 0o755 });
  if (bundle) git('bundle', 'create', join(dir, 'branch.bundle'), 'agent/issue-7');
  const remote = join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
  return { dir, remote };
}

function publish(dir, remote, extraEnv = {}) {
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [PUBLISH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${STUBS}:${process.env.PATH}`,
      GH_LOG: log,
      VERDICT: join(dir, 'verdict.json'),
      REPO: 'o/r',
      GH_TOKEN: 'x',
      RUN_URL: 'https://run',
      BUNDLE: join(dir, 'branch.bundle'),
      PUSH_REMOTE: remote,
      HOOK_RAN: join(dir, 'hook-ran'),
      ...extraEnv,
    },
  });
  return { status: r.status, stderr: r.stderr, log: readFileSync(log, 'utf8') };
}

const remoteHas = (remote, ref) => spawnSync('git', ['-C', remote, 'rev-parse', '-q', '--verify', ref]).status === 0;

test('READY_FOR_QA pushes from the bundle, opens a PR, labels and comments', () => {
  const { dir, remote } = setup(baseVerdict);
  const r = publish(dir, remote);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(remoteHas(remote, 'refs/heads/agent/issue-7'));
  assert.match(r.log, /gh issue edit 7 --repo o\/r --remove-label agent --remove-label agent:running/);
  assert.match(r.log, /gh pr create --repo o\/r --base main --head agent\/issue-7 --title Task 1: Add greeting/);
  assert.match(r.log, /--add-label agent:ready/);
  assert.match(r.log, /READY_FOR_QA\*\* — https:\/\/github\.com\/o\/r\/pull\/9/);
  assert.equal(spawnSync('test', ['-e', join(dir, 'hook-ran')]).status, 1, 'agent hook must not run');
});

test('a failing PR creation still leaves a BLOCKED label and a comment', () => {
  const { dir, remote } = setup(baseVerdict);
  const r = publish(dir, remote, { GH_FAIL_PR_CREATE: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.log, /--add-label agent:blocked/);
  assert.match(r.log, /publishing failed at step: pr/);
});

test('BLOCKED with commits pushes the attempt for inspection', () => {
  const { dir, remote } = setup({ ...baseVerdict, outcome: 'BLOCKED', kind: 'gate', reasons: ['check "test" failed'] });
  const r = publish(dir, remote);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(remoteHas(remote, 'refs/heads/agent/issue-7'));
  assert.match(r.log, /--add-label agent:blocked/);
  assert.match(r.log, /check "test" failed/);
  assert.doesNotMatch(r.log, /pr create/);
});

test('BLOCKED without a bundle only comments', () => {
  const { dir, remote } = setup({ ...baseVerdict, outcome: 'BLOCKED', kind: 'gate', reasons: ['bad task reference: x'], commits: 0 }, { bundle: false });
  const r = publish(dir, remote);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteHas(remote, 'refs/heads/agent/issue-7'), false);
  assert.match(r.log, /bad task reference/);
});
