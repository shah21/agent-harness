// Token lists per owner, tried in order (fine-grained first, classic last). Nothing here
// echoes a token, an owner or a repository: the log it runs in is public.
const OWNER_RE = /^[A-Za-z0-9_-]+$/;

export function parseTokenMap(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('tokens: not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tokens: must be a JSON object of owner: [token, ...]');
  const entries = Object.entries(raw);
  if (entries.length === 0) throw new Error('tokens: no owners listed');
  const map = {};
  entries.forEach(([owner, list], i) => {
    if (!OWNER_RE.test(owner)) throw new Error(`tokens: entry ${i} has an invalid owner name`);
    if (!Array.isArray(list) || list.length === 0 || list.some((t) => typeof t !== 'string' || !t.trim())) {
      throw new Error(`tokens: entry ${i} must be a non-empty array of token strings`);
    }
    map[owner] = list.map((t) => t.trim());
  });
  return map;
}

export function tokenKind(token) {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  return 'unknown';
}

export async function resolveToken({ repo, tokens, needsWrite, probe }) {
  for (let index = 0; index < tokens.length; index++) {
    const r = await probe(tokens[index], repo);
    if (!r?.ok) continue;
    const p = r.permissions ?? {};
    if (!p.pull) continue;
    if (needsWrite && !p.push) continue;
    return { index, kind: tokenKind(tokens[index]) };
  }
  return null;
}

export function makeProbe(fetchImpl = fetch) {
  return async (token, repo) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'agent-runner',
      },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json();
    return { ok: true, status: res.status, permissions: body.permissions ?? {} };
  };
}
