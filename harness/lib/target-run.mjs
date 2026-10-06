// Git operations on the target clone (superproject + submodules) inside the consumer checkout.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseGitmodules, renderBranch, fill, TEMPLATE_VARS } from './target.mjs';

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function prepareTarget({ projectDir, outDir, target, issue, task, taskTitle, parentBases }) {
  const reasonFile = join(outDir, 'target-checkout.txt');
  if (existsSync(reasonFile)) return { error: readFileSync(reasonFile, 'utf8').trim() || 'target checkout failed' };
  if (spawnSync('git', ['check-ignore', '-q', `${target.path}/`], { cwd: projectDir }).status !== 0) {
    return { error: `target path "${target.path}" is not git-ignored` };
  }
  const superDir = join(projectDir, target.path);
  if (!existsSync(join(superDir, '.git'))) return { error: 'target checkout failed' };

  let branch;
  let subs;
  try {
    branch = renderBranch(target.branch, { issue: issue.number, task, taskTitle });
    const modules = join(superDir, '.gitmodules');
    subs = existsSync(modules) ? parseGitmodules(readFileSync(modules, 'utf8')) : [];
  } catch (e) {
    return { error: e.message };
  }

  let prTemplate = null;
  if (target.pr.body) {
    const p = join(projectDir, target.pr.body);
    if (!existsSync(p)) return { error: `PR body template not found: ${target.pr.body}` };
    prTemplate = readFileSync(p, 'utf8');
    try {
      fill(prTemplate, Object.fromEntries(TEMPLATE_VARS.map((v) => [v, ''])));
    } catch (e) {
      return { error: `PR body template ${target.pr.body}: ${e.message}` };
    }
  }

  const depth = (p) => p.split('/').length;
  const repos = [
    ...subs
      .filter((s) => existsSync(join(superDir, s.path, '.git')))
      .sort((a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path))
      .map((s) => ({ repo: s.repo, path: `${target.path}/${s.path}`, role: 'sub', subPath: s.path })),
    { repo: target.repo, path: target.path, role: 'super' },
  ].map((r) => ({ ...r, dir: join(projectDir, r.path), base: parentBases?.[r.repo] ?? null }));
  return { branch, repos, prTemplate };
}

export function startTargetBranches(t, author) {
  for (const r of t.repos) {
    git(r.dir, 'checkout', '-q', '-B', t.branch);
    git(r.dir, 'config', 'user.name', author?.name ?? 'agent-harness');
    git(r.dir, 'config', 'user.email', author?.email ?? 'agent-harness@users.noreply.github.com');
    r.baseSha = git(r.dir, 'rev-parse', 'HEAD');
  }
}

export function resetTargets(t) {
  for (const r of t.repos) {
    git(r.dir, 'checkout', '-q', '-f', t.branch);
    git(r.dir, 'reset', '-q', '--hard', r.baseSha);
    git(r.dir, 'clean', '-fdq');
  }
}
