// The runner's list of private projects. It lives in a private place and is read at run
// time. Messages name a position, never a repository: this code runs where logs are public.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OWNER_RE = /^[A-Za-z0-9_-]+$/;

export function parseProjects(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('projects: not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('projects: must be a JSON object');
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) throw new Error('projects: "projects" must be a non-empty array');
  const maxParallel = raw.maxParallel ?? 3;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) {
    throw new Error('projects: "maxParallel" must be an integer from 1 to 10');
  }
  const seen = new Set();
  const projects = raw.projects.map((p, i) => {
    if (typeof p?.repo !== 'string' || !REPO_RE.test(p.repo)) throw new Error(`projects[${i}]: "repo" must be "owner/name"`);
    const key = p.repo.toLowerCase();
    if (seen.has(key)) throw new Error(`projects[${i}]: duplicate repository`);
    seen.add(key);
    const tokenOwner = p.tokenOwner ?? p.repo.split('/')[0];
    if (typeof tokenOwner !== 'string' || !OWNER_RE.test(tokenOwner)) throw new Error(`projects[${i}]: "tokenOwner" is not a valid owner name`);
    const out = { repo: p.repo, tokenOwner };
    if (p.targetTokenOwner !== undefined) {
      if (typeof p.targetTokenOwner !== 'string' || !OWNER_RE.test(p.targetTokenOwner)) {
        throw new Error(`projects[${i}]: "targetTokenOwner" is not a valid owner name`);
      }
      out.targetTokenOwner = p.targetTokenOwner;
    }
    return out;
  });
  return { projects, maxParallel };
}
