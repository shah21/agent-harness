// Debug runs are read-only. After the agent exits, anything it changed in a
// git checkout is reverted; only the report text is ever published.
import { execFileSync } from 'node:child_process';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const state = (dir) => ({
  head: git(dir, 'rev-parse', 'HEAD'),
  branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
  status: git(dir, 'status', '--porcelain'),
});

export function snapshot(dirs) {
  return dirs.map((dir) => ({ dir, ...state(dir) }));
}

// Innermost repositories first, so a submodule is restored before the repository that contains it.
export function enforceReadOnly(snaps) {
  const changed = [];
  for (const s of [...snaps].reverse()) {
    const now = state(s.dir);
    if (now.head === s.head && now.branch === s.branch && now.status === s.status) continue;
    changed.push(s.dir);
    git(s.dir, 'checkout', '-q', '-f', ...(s.branch === 'HEAD' ? ['--detach', s.head] : [s.branch]));
    git(s.dir, 'reset', '-q', '--hard', s.head);
    git(s.dir, 'clean', '-ffdq');
  }
  return changed.reverse();
}
