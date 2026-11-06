// The owner's allow-list is applied to what git itself will fetch. A hand-written .gitmodules parser
// can disagree with git (section and key names are case-insensitive, a header may carry a comment,
// a later key overrides an earlier one), and a disagreement here means a token clones the wrong
// repository. So git reads the file, and after `git submodule init` git is asked again which URLs
// it registered.
import { execFileSync } from 'node:child_process';

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

function gitRecords(args, pattern) {
  let out;
  try {
    out = execFileSync('git', [...args, '-z', '--get-regexp', pattern], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e.status === 1) return []; // no match
    throw new Error('git config failed');
  }
  return out.split('\0').filter(Boolean).map((r) => {
    const i = r.indexOf('\n');
    return i < 0 ? [r, ''] : [r.slice(0, i), r.slice(i + 1)];
  });
}

const safePath = (p) => p !== '' && !p.startsWith('/') && !p.startsWith('-') && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

function repoOf(url, allowed) {
  const m = GITHUB_URL.exec(url);
  if (!m || !allowed.has(m[1].toLowerCase())) throw new Error('not allowed');
  return m[1];
}

// Paths of the submodules a .gitmodules file declares, if every one is allowed and unambiguous.
export function planSubmodules(file, allowRepos) {
  const allowed = new Set(allowRepos.map((r) => r.toLowerCase()));
  // A file that pulls in other files is not a file this check can vouch for.
  if (gitRecords(['config', '-f', file], '^(include|includeif)\\.').length > 0) throw new Error('not allowed');
  const byName = new Map();
  for (const [key, value] of gitRecords(['config', '-f', file], '^submodule\\..*\\.(path|url)$')) {
    const name = key.slice('submodule.'.length, key.lastIndexOf('.'));
    const variable = key.slice(key.lastIndexOf('.') + 1);
    const entry = byName.get(name) ?? { path: [], url: [] };
    entry[variable].push(value);
    byName.set(name, entry);
  }
  const paths = [];
  for (const { path, url } of byName.values()) {
    if (path.length !== 1 || url.length !== 1 || !safePath(path[0])) throw new Error('not allowed');
    repoOf(url[0], allowed);
    paths.push(path[0]);
  }
  return paths;
}

// The URLs git registered in a checkout's own config (after `git submodule init`).
export function verifyRegisteredSubmodules(repoDir, allowRepos) {
  const allowed = new Set(allowRepos.map((r) => r.toLowerCase()));
  for (const [, url] of gitRecords(['-C', repoDir, 'config'], '^submodule\\..*\\.url$')) repoOf(url, allowed);
}
