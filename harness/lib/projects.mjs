// The runner's list of private projects. It lives in a private place, is controlled by the
// owner alone, and is read at run time. It is the only place that decides which repositories a
// run may clone: a project's own agent.config.json and .gitmodules can only choose from it.
// Messages name a position, never a repository: this code runs where logs are public.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OWNER_RE = /^[A-Za-z0-9_-]+$/;
const PREFIX_RE = /^[a-z0-9][a-z0-9._-]*\/$/;
// One per slot of the shared workflow.
export const MAX_SLOTS = 3;
const PROJECT_KEYS = new Set(['repo', 'tokenOwner', 'target', 'isolated']);
const TARGET_KEYS = new Set(['repo', 'tokenOwner', 'allow', 'branchPrefixes']);

function repoList(value, i, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((r) => typeof r !== 'string' || !REPO_RE.test(r)) || new Set(value).size !== value.length) {
    throw new Error(`projects[${i}]: target "${field}" must be a list of unique "owner/name"`);
  }
  return [...value];
}

function targetEntry(t, i) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error(`projects[${i}]: "target" must be an object`);
  if (Object.keys(t).some((k) => !TARGET_KEYS.has(k))) throw new Error(`projects[${i}]: "target" has an unknown field`);
  if (typeof t.repo !== 'string' || !REPO_RE.test(t.repo)) throw new Error(`projects[${i}]: target "repo" must be "owner/name"`);
  const tokenOwner = t.tokenOwner ?? t.repo.split('/')[0];
  if (typeof tokenOwner !== 'string' || !OWNER_RE.test(tokenOwner)) throw new Error(`projects[${i}]: target "tokenOwner" is not a valid owner name`);
  const prefixes = t.branchPrefixes ?? [];
  if (!Array.isArray(prefixes) || prefixes.some((p) => typeof p !== 'string' || !PREFIX_RE.test(p))) {
    throw new Error(`projects[${i}]: target "branchPrefixes" must be a list of prefixes like "team/"`);
  }
  return { repo: t.repo, tokenOwner, allow: repoList(t.allow, i, 'allow'), branchPrefixes: [...prefixes] };
}

export function parseProjects(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('projects: not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('projects: must be a JSON object');
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) throw new Error('projects: "projects" must be a non-empty array');
  const maxParallel = raw.maxParallel ?? MAX_SLOTS;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_SLOTS) {
    throw new Error(`projects: "maxParallel" must be an integer from 1 to ${MAX_SLOTS}`);
  }
  const seen = new Set();
  const projects = raw.projects.map((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`projects[${i}]: must be an object`);
    if (Object.keys(p).some((k) => !PROJECT_KEYS.has(k))) throw new Error(`projects[${i}]: unknown field`);
    if (typeof p.repo !== 'string' || !REPO_RE.test(p.repo)) throw new Error(`projects[${i}]: "repo" must be "owner/name"`);
    const key = p.repo.toLowerCase();
    if (seen.has(key)) throw new Error(`projects[${i}]: duplicate repository`);
    seen.add(key);
    const tokenOwner = p.tokenOwner ?? p.repo.split('/')[0];
    if (typeof tokenOwner !== 'string' || !OWNER_RE.test(tokenOwner)) throw new Error(`projects[${i}]: "tokenOwner" is not a valid owner name`);
    const out = { repo: p.repo, tokenOwner };
    if (p.target !== undefined) out.target = targetEntry(p.target, i);
    // An isolated project runs alone in its round: no other project's code runs beside it.
    if (p.isolated !== undefined) {
      if (typeof p.isolated !== 'boolean') throw new Error(`projects[${i}]: "isolated" must be true or false`);
      out.isolated = p.isolated;
    }
    return out;
  });
  return { projects, maxParallel };
}
