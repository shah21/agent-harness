import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RELATED_TOKEN } from '../../harness/lib/target.mjs';

const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Remote at <dir>/remotes/<owner>/<name>.git with one base commit, plus a thin bundle of
// one task commit on `branch`. Returns the verdict.targets entry.
function makeRepo(dir, repo, role, branch) {
  const remote = join(dir, 'remotes', `${repo}.git`);
  mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const work = join(dir, 'work', repo);
  mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'base.txt'), 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  git(work, 'push', '-q', remote, 'main');
  const baseSha = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', branch);
  writeFileSync(join(work, 'change.txt'), `${repo}\n`);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'task');
  const bundle = `bundles/${repo.replace('/', '__')}.bundle`;
  mkdirSync(join(dir, 'bundles'), { recursive: true });
  git(work, 'bundle', 'create', join(dir, bundle), `${baseSha}..refs/heads/${branch}`);
  // A hook in the agent's repository must never run while publishing.
  writeFileSync(join(work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\ntouch "$HOOK_RAN"\n', { mode: 0o755 });
  return {
    repo, path: role === 'super' ? 'target' : 'target/sub', role, branch, base: null, baseSha, commits: 1, bundle,
    prTitle: `Title ${repo}`, prBody: `Body ${repo}\n${RELATED_TOKEN}\n`,
  };
}

export function makeTargetsFixture({ branch = 'fix/x' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-targets-'));
  const targets = [makeRepo(dir, 'o/sub', 'sub', branch), makeRepo(dir, 'o/super', 'super', branch)];
  return { dir, targets, remoteTemplate: `file://${dir}/remotes/{repo}.git` };
}

export const remoteHasBranch = (dir, repo, branch) =>
  execFileSync('git', ['-C', join(dir, 'remotes', `${repo}.git`), 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== '';
