// A small GitHub REST client over an injected fetch. Messages name a status, never a path:
// paths contain repository names, and this runs where logs are public.
const API = 'https://api.github.com';
const enc = (p) => encodeURIComponent(p);
const encPath = (p) => p.split('/').map(enc).join('/');

export function githubClient({ token, fetchImpl = fetch }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'agent-runner',
  };
  const call = (method, path, body) => fetchImpl(`${API}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function getJson(path) {
    const res = await call('GET', path);
    if (!res.ok) throw new Error(`github: GET failed (${res.status})`);
    return res.json();
  }
  async function send(method, path, body) {
    const res = await call(method, path, body);
    if (!res.ok) throw new Error(`github: ${method} failed (${res.status})`);
  }
  async function pages(path, max = 200) {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const items = await getJson(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out.slice(0, max);
  }

  return {
    async defaultBranch(repo) {
      return (await getJson(`/repos/${repo}`)).default_branch;
    },
    async openIssues(repo) {
      return (await pages(`/repos/${repo}/issues?state=open`))
        .filter((i) => !i.pull_request)
        .map((i) => ({ number: i.number, title: i.title, body: i.body ?? '', labels: i.labels.map((l) => ({ name: l.name })), updatedAt: i.updated_at }));
    },
    async openPrs(repo) {
      return (await pages(`/repos/${repo}/pulls?state=open`, 100)).map((p) => ({
        number: p.number,
        headRefName: p.head.ref,
        body: p.body ?? '',
        isCrossRepository: p.head.repo?.full_name !== p.base.repo.full_name,
      }));
    },
    async comments(repo, n) {
      // Comments come oldest first and the READY comment is near the end, so read the last two
      // pages at most: a project must not be able to make the runner spend an unbounded number
      // of calls on the owner's shared token.
      const base = `/repos/${repo}/issues/${n}/comments?per_page=100`;
      const first = await call('GET', `${base}&page=1`);
      if (!first.ok) throw new Error(`github: GET failed (${first.status})`);
      const items = await first.json();
      const last = Number(/[?&]page=(\d+)>;\s*rel="last"/.exec(first.headers?.get?.('link') ?? '')?.[1] ?? 1);
      let out = items;
      if (last > 1) {
        out = [];
        for (const page of [last - 1, last]) out.push(...(page === 1 ? items : await getJson(`${base}&page=${page}`)));
      }
      return out.map((c) => ({ body: c.body ?? '' }));
    },
    async prMerged(repo, n) {
      return (await getJson(`/repos/${repo}/pulls/${n}`)).merged === true;
    },
    async closedMergedPrs(repo) {
      return (await getJson(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`))
        .filter((p) => p.merged_at)
        .map((p) => ({ merged: true, head: { ref: p.head.ref, repo: p.head.repo && { full_name: p.head.repo.full_name } }, base: { repo: { full_name: p.base.repo.full_name } }, body: p.body ?? '' }));
    },
    async setLabels(repo, n, { add = [], remove = [] }) {
      for (const name of remove) {
        const res = await call('DELETE', `/repos/${repo}/issues/${n}/labels/${enc(name)}`);
        if (!res.ok && res.status !== 404) throw new Error(`github: DELETE failed (${res.status})`);
      }
      if (add.length > 0) await send('POST', `/repos/${repo}/issues/${n}/labels`, { labels: add });
    },
    async comment(repo, n, body) {
      await send('POST', `/repos/${repo}/issues/${n}/comments`, { body });
    },
    async closeIssue(repo, n) {
      await send('PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed', state_reason: 'completed' });
    },
    async fileContent(repo, path, ref) {
      const res = await call('GET', `/repos/${repo}/contents/${encPath(path)}${ref ? `?ref=${enc(ref)}` : ''}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github: GET failed (${res.status})`);
      const body = await res.json();
      return Buffer.from(body.content ?? '', body.encoding ?? 'base64').toString('utf8');
    },
    async putFile(repo, path, content, message) {
      const url = `/repos/${repo}/contents/${encPath(path)}`;
      const cur = await call('GET', url);
      let sha;
      if (cur.ok) sha = (await cur.json()).sha;
      else if (cur.status !== 404) throw new Error(`github: GET failed (${cur.status})`);
      await send('PUT', url, { message, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) });
    },
  };
}
