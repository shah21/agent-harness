import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeTargetProject } from './helpers/target-fixture.mjs';

const SCRIPT = new URL('../harness/checkout-prs.sh', import.meta.url).pathname;
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function run(plan, project, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'checkout-prs-'));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8', env: { ...process.env, ...env, PLAN: join(dir, 'plan.json'), PROJECT: project, OUT: join(dir, 'out.json') },
  });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) : null };
}

// A consumer clone whose remote has main plus a pull request branch that forked from main.
function consumer() {
  const root = mkdtempSync(join(tmpdir(), 'checkout-prs-remote-'));
  const remote = join(root, 'r.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const work = join(root, 'work');
  execFileSync('git', ['clone', '-q', remote, work]);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(work, 'a.txt'), 'b\n');
  git(work, 'commit', '-qam', 'change');
  git(work, 'push', '-q', 'origin', 'feature');
  const head = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', 'main');
  writeFileSync(join(work, 'm.txt'), 'later\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'main moves on');
  git(work, 'push', '-q', 'origin', 'main');
  const project = join(root, 'project');
  execFileSync('git', ['clone', '-q', remote, project]);
  return { project, base, head };
}

test('checks out the head detached and records the merge base', () => {
  const { project, base, head } = consumer();
  const entry = { repo: 'o/r', number: 5, dir: '.', prefix: '', auth: 'consumer', headSha: head, baseRef: 'main' };
  const { status, stderr, out } = run([entry], project);
  assert.equal(status, 0, stderr);
  assert.deepEqual(out, [{ ...entry, baseSha: base }]);
  assert.equal(git(project, 'rev-parse', 'HEAD'), head);
  assert.equal(git(project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
});

test('an unknown head fails', () => {
  const { project } = consumer();
  const { status } = run([{ repo: 'o/r', number: 5, dir: '.', prefix: '', auth: 'consumer', headSha: 'f'.repeat(40), baseRef: 'main' }], project);
  assert.notEqual(status, 0);
});

test('a superproject head brings its submodule along', () => {
  const { projectDir, remotes } = makeTargetProject();
  const scratch = mkdtempSync(join(tmpdir(), 'checkout-prs-super-'));
  const subWork = join(scratch, 'sub');
  execFileSync('git', ['clone', '-q', remotes.sub, subWork]);
  writeFileSync(join(subWork, 'lib.txt'), 'pr\n');
  git(subWork, 'commit', '-qam', 'sub change');
  git(subWork, 'push', '-q', 'origin', 'HEAD:refs/heads/pr');
  const subHead = git(subWork, 'rev-parse', 'HEAD');
  const supWork = join(scratch, 'super');
  execFileSync('git', ['clone', '-q', '--recurse-submodules', remotes.super, supWork], { env: { ...process.env, ...remotes.gitEnv }, stdio: 'ignore' });
  execFileSync('git', ['fetch', '-q', 'origin', 'pr'], { cwd: join(supWork, 'packages', 'core'), env: { ...process.env, ...remotes.gitEnv }, stdio: 'ignore' });
  git(join(supWork, 'packages', 'core'), 'checkout', '-q', subHead);
  git(supWork, 'checkout', '-q', '-b', 'pr');
  git(supWork, 'add', 'packages/core');
  git(supWork, 'commit', '-qm', 'point at the sub change');
  git(supWork, 'push', '-q', 'origin', 'pr');
  const supHead = git(supWork, 'rev-parse', 'HEAD');

  const entry = { repo: 'o/super', number: 12, dir: 'target', prefix: 'target/', auth: 'target', headSha: supHead, baseRef: 'main' };
  const { status, stderr } = run([entry], projectDir, remotes.gitEnv);
  assert.equal(status, 0, stderr);
  assert.equal(git(join(projectDir, 'target'), 'rev-parse', 'HEAD'), supHead);
  assert.equal(git(join(projectDir, 'target', 'packages', 'core'), 'rev-parse', 'HEAD'), subHead);
});
