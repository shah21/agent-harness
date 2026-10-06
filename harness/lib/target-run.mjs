// Git operations on the target clone (superproject + submodules) inside the consumer checkout.
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
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

export function targetsOffBranch(t) {
  for (const r of t.repos) {
    const head = git(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (head !== t.branch) return { path: r.path, head };
  }
  return null;
}

// Submodule pointer changes are left alone here; pointerErrors judges them.
export function stashTargets(t) {
  let stashed = false;
  for (const r of t.repos) {
    if (git(r.dir, 'status', '--porcelain', '--ignore-submodules=all')) {
      git(r.dir, 'stash', 'push', '--include-untracked', '-q', '-m', 'agent-harness: uncommitted changes');
      stashed = true;
    }
  }
  return stashed;
}

export function measureTargets(t, parseDiff) {
  for (const r of t.repos) {
    r.commits = Number(git(r.dir, 'rev-list', '--count', `${r.baseSha}..HEAD`));
    r.diff = parseDiff(git(r.dir, 'diff', '--name-status', '-M', r.baseSha, 'HEAD'));
    r.prefixedDiff = r.diff.map((d) => ({
      ...d,
      path: `${r.path}/${d.path}`,
      ...(d.oldPath ? { oldPath: `${r.path}/${d.oldPath}` } : {}),
    }));
  }
}

export function pointerErrors(t) {
  const sup = t.repos.find((r) => r.role === 'super');
  return t.repos
    .filter((r) => r.role === 'sub' && r.commits > 0)
    .filter((r) => git(sup.dir, 'rev-parse', `HEAD:${r.subPath}`) !== git(r.dir, 'rev-parse', 'HEAD'))
    .map((r) => `submodule ${r.path} changed but the superproject does not point at it`);
}

// Thin bundles (<base>..<branch>): the artifact carries the task's commits, not the history.
export function bundleTargets(t, outDir) {
  const dir = join(outDir, 'bundles');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return t.repos.map((r) => {
    let bundle = null;
    if (r.commits > 0) {
      bundle = `bundles/${r.repo.replace('/', '__')}.bundle`;
      git(r.dir, 'bundle', 'create', join(outDir, bundle), `${r.baseSha}..refs/heads/${t.branch}`);
    }
    return { repo: r.repo, path: r.path, role: r.role, branch: t.branch, base: r.base, baseSha: r.baseSha, commits: r.commits, bundle };
  });
}
