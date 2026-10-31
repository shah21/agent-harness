# Shared Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One public runner repository runs the harness for many private projects, with nothing readable about a project in public except that a run happened, when, and for how long.

**Architecture:** New pure modules (project list, token resolution, a small GitHub client, cross-project selection, encryption, leak checks, run records) plus three entry scripts, one reusable workflow `run-shared.yml` and a caller template. The existing per-repository mode (`run-task.yml`, `agent.yml`) is untouched and keeps working until each project is cut over. `publish.sh`, `run-task.mjs` and `queue.mjs` are reused as they are.

**Tech Stack:** Node >= 22 (no dependencies), `node:test`, GitHub Actions, bash, `tar` (present on hosted runners and macOS).

**Spec:** `docs/superpowers/specs/2026-10-31-shared-runner-design.md`

## Global Constraints

- No dependencies. Node built-ins only. Tests never touch the network: GitHub is reached through an injected `fetchImpl`.
- Every string that can reach a public log, a run name, a job name, an artifact name or a concurrency group is neutral: no repository name, owner name, issue title, plan path or project text. Use indices.
- Error messages from the new modules never echo their input (project list, token map, repository, token, key). `JSON.parse` messages include a snippet of the input, so they are replaced by fixed messages.
- Tokens: never in a URL, never written to git config on disk, never in the environment of the agent step. A token is passed to git as a one-command `http.extraheader`.
- No project, work or company name appears in any file this plan creates, including tests and docs. Examples use `alice/one`, `org/two`.
- `.github/**` and `agent.config.json` are protected paths: an agent run cannot change them. Task 8 is a hand task.
- The suite must stay green at every commit: `npm test`. Baseline before this plan: 452 tests.
- Encryption is `node:crypto` AES-256-GCM with a scrypt-derived key. No `gpg`, no `age`.
- Run record fields are an allow-list. Never spread a verdict into a record.

## Review Focus

The inputs and conditions the tasks' main tests do not exercise, most likely to bite first. Each line has its pinning test in the task that owns the code.

1. A project whose token list cannot reach it is skipped, and nothing printed names it. (Task 4)
2. A malformed project list or token map is rejected without echoing any part of it. (Tasks 1, 2)
3. A crashed run leaves `agent:running` behind; the project must not stay frozen forever. (Task 3)
4. `needs.run.result` aggregates the whole matrix: one failed project must not make another project's good output look failed. (Task 8, lint test)
5. `publish.sh` ends with an `echo` containing the PR URL, and `git`/`gh` errors contain the repository: neither may reach the public log. (Task 8, lint test)

---

### Task 0: Spike on a throwaway pair of repositories (hand, no code kept)

Settles the points the spec lists under "Risks". Use a scratch public repository and a scratch private repository with no real content. Nothing here is committed to this repository except the findings.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-31-shared-runner-design.md` (section 9, record findings)

- [ ] **Step 1: Matrix and run names.** In the scratch public repo, run a workflow with `run-name: run`, a matrix job `name: run (${{ matrix.index }})` over `[0,1]`, and a job-level `concurrency.group: ${{ matrix.index }}`. Open the run page signed out. Expected: only `run (0)`, `run (1)` and no other project text. Record what the page and the API (`gh api repos/<scratch>/actions/runs/<id>/jobs`) show.
- [ ] **Step 2: Fine-grained token probe.** With a fine-grained token that has contents read only on the scratch private repo, call `GET /repos/<scratch>`. Record whether `permissions.push` is `false` (token scope reflected) or `true` (user role reflected). If it reflects the user role, the permission probe in Task 2 cannot tell read-only from write: switch `resolveToken` to try a harmless real write (see the note in Task 2) and record that decision.
- [ ] **Step 3: Clone error text.** Run `git clone` against the scratch private repo with a bad token and with no access. Record that the error names the repository (it does in current git), which is why the clone script silences stderr.
- [ ] **Step 4: Scheduled workflows.** Confirm in GitHub's documentation whether scheduled workflows in a public repository are disabled after 60 days without repository activity, and what re-enables them. Record the keep-alive decision.
- [ ] **Step 5: Commit the findings**

```bash
git add docs/superpowers/specs/2026-10-31-shared-runner-design.md
git commit -m "docs: record shared runner spike findings"
```

---

### Task 1: The project list

**Files:**
- Create: `harness/lib/projects.mjs`
- Test: `test/projects.test.mjs`

**Interfaces:**
- Produces: `parseProjects(text: string): { projects: { repo: string, tokenOwner: string, targetTokenOwner?: string }[], maxParallel: number }`. Throws `Error` with messages that contain no repository name.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjects } from '../harness/lib/projects.mjs';

const text = (o) => JSON.stringify(o);

test('reads projects; the token owner defaults to the repo owner and the cap to 3', () => {
  const r = parseProjects(text({ projects: [{ repo: 'alice/one' }, { repo: 'org/two', tokenOwner: 'alice', targetTokenOwner: 'org' }] }));
  assert.deepEqual(r, {
    projects: [
      { repo: 'alice/one', tokenOwner: 'alice' },
      { repo: 'org/two', tokenOwner: 'alice', targetTokenOwner: 'org' },
    ],
    maxParallel: 3,
  });
});

test('maxParallel must be an integer from 1 to 10', () => {
  assert.equal(parseProjects(text({ projects: [{ repo: 'a/b' }], maxParallel: 5 })).maxParallel, 5);
  for (const bad of [0, 11, 2.5, '3']) {
    assert.throws(() => parseProjects(text({ projects: [{ repo: 'a/b' }], maxParallel: bad })), /maxParallel/);
  }
});

test('rejects an empty list, bad repo names, duplicates and bad owners', () => {
  assert.throws(() => parseProjects(text({ projects: [] })), /non-empty/);
  assert.throws(() => parseProjects(text({ projects: [{ repo: 'no-slash' }] })), /projects\[0\]/);
  assert.throws(() => parseProjects(text({ projects: [{ repo: 'a/b' }, { repo: 'A/B' }] })), /projects\[1\].*duplicate/);
  assert.throws(() => parseProjects(text({ projects: [{ repo: 'a/b', tokenOwner: 'bad owner' }] })), /tokenOwner/);
});

test('error messages never contain a repository name or any input text (the log is public)', () => {
  const bad = [
    '{"projects":[{"repo":"zzsecret/name!"}]}',
    '{"projects":[{"repo":"zzsecret/dup"},{"repo":"zzsecret/dup"}]}',
    '{"projects":[{"repo":"zzsecret/x","tokenOwner":"zz bad"}]}',
    'zzsecret-not-json',
    '[]',
  ];
  for (const input of bad) {
    assert.throws(() => parseProjects(input), (e) => !/zzsecret|zz bad/.test(e.message));
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/projects.test.mjs`
Expected: FAIL, `Cannot find module '../harness/lib/projects.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
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
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/projects.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add harness/lib/projects.mjs test/projects.test.mjs
git commit -m "feat: parse the shared runner's project list"
```

---

### Task 2: Token map and token resolution

**Files:**
- Create: `harness/lib/tokens.mjs`
- Test: `test/tokens.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `parseTokenMap(text: string): Record<string, string[]>` (owner to ordered tokens, fine-grained first by convention).
  - `tokenKind(token: string): 'fine-grained' | 'classic' | 'unknown'`.
  - `resolveToken({ repo, tokens, needsWrite, probe }): Promise<{ index: number, kind: string } | null>` where `probe(token, repo): Promise<{ ok: boolean, status: number, permissions?: { pull?: boolean, push?: boolean } }>`.
  - `makeProbe(fetchImpl = fetch): probe`.

**Note from Task 0:** if the spike shows that `permissions` does not reflect a fine-grained token's scope, replace the `push` check in `resolveToken` with a probe that attempts a harmless real write (for example creating the `agent` label, treating "already exists" as success and 403/404 as no access), and change `makeProbe` accordingly. The tests below stay valid for the read path.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenMap, tokenKind, resolveToken, makeProbe } from '../harness/lib/tokens.mjs';

test('parseTokenMap reads owner: [tokens] and trims', () => {
  assert.deepEqual(parseTokenMap('{"alice":[" github_pat_a ","ghp_b"],"org":["ghp_c"]}'), {
    alice: ['github_pat_a', 'ghp_b'],
    org: ['ghp_c'],
  });
});

test('parseTokenMap rejects bad shapes without echoing owners or tokens', () => {
  const bad = ['{"zz secret":["ghp_zzsecret"]}', '{"alice":[]}', '{"alice":[""]}', '{"alice":"ghp_zzsecret"}', 'ghp_zzsecret', '[]', '{}'];
  for (const input of bad) {
    assert.throws(() => parseTokenMap(input), (e) => !/zzsecret|zz secret|alice/.test(e.message), input);
  }
});

test('tokenKind tells the two kinds apart by prefix', () => {
  assert.equal(tokenKind('github_pat_abc'), 'fine-grained');
  assert.equal(tokenKind('ghp_abc'), 'classic');
  assert.equal(tokenKind('abc'), 'unknown');
});

const probeFrom = (table) => async (token) => table[token] ?? { ok: false, status: 404 };
const reads = { ok: true, status: 200, permissions: { pull: true, push: false } };
const writes = { ok: true, status: 200, permissions: { pull: true, push: true } };

test('resolveToken takes the first token that can do what is needed', async () => {
  const tokens = ['github_pat_a', 'ghp_b'];
  const probe = probeFrom({ github_pat_a: reads, ghp_b: writes });
  assert.deepEqual(await resolveToken({ repo: 'a/b', tokens, needsWrite: true, probe }), { index: 1, kind: 'classic' });
  assert.deepEqual(await resolveToken({ repo: 'a/b', tokens, needsWrite: false, probe }), { index: 0, kind: 'fine-grained' });
});

test('resolveToken skips tokens that cannot see the repository and returns null when none can', async () => {
  assert.deepEqual(
    await resolveToken({ repo: 'a/b', tokens: ['github_pat_a', 'ghp_b'], needsWrite: true, probe: probeFrom({ ghp_b: writes }) }),
    { index: 1, kind: 'classic' },
  );
  assert.equal(await resolveToken({ repo: 'a/b', tokens: ['x'], needsWrite: false, probe: probeFrom({}) }), null);
});

test('makeProbe sends a bearer token to the repository endpoint and reads the permissions', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ permissions: { pull: true, push: true } }) };
  };
  const r = await makeProbe(fetchImpl)('tok', 'a/b');
  assert.deepEqual(r, { ok: true, status: 200, permissions: { pull: true, push: true } });
  assert.deepEqual(seen, [{ url: 'https://api.github.com/repos/a/b', auth: 'Bearer tok' }]);
  const none = await makeProbe(async () => ({ ok: false, status: 404, json: async () => ({}) }))('tok', 'a/b');
  assert.deepEqual(none, { ok: false, status: 404 });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/tokens.test.mjs`
Expected: FAIL, `Cannot find module '../harness/lib/tokens.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
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
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/tokens.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add harness/lib/tokens.mjs test/tokens.test.mjs
git commit -m "feat: token map and first-token-that-works resolution"
```

---

### Task 3: GitHub client and selection across projects

**Files:**
- Create: `harness/lib/github.mjs`, `harness/lib/shared-select.mjs`, `test/helpers/fake-fetch.mjs`
- Test: `test/github.test.mjs`, `test/shared-select.test.mjs`

**Interfaces:**
- Consumes: `selectNext` from `harness/lib/queue.mjs`; `issueToClose` from `harness/lib/merged.mjs`.
- Produces:
  - `githubClient({ token, fetchImpl }): { defaultBranch(repo), openIssues(repo), openPrs(repo), comments(repo, n), closedMergedPrs(repo), setLabels(repo, n, { add, remove }), comment(repo, n, body), closeIssue(repo, n), fileContent(repo, path, ref?), putFile(repo, path, content, message) }`. Issues are `{ number, title, body, labels: [{ name }], updatedAt }`. Errors name no repository.
  - `loadProject(client, repo): Promise<{ defaultBranch, issues, prs, ready, configText }>`.
  - `runningState(issues, now): { busy: boolean, stale: number[] }`, `STALE_MS = 3 * 60 * 60 * 1000`.
  - `closeMergedFor({ repo, client, issues }): Promise<number[]>`.
  - `selectAcrossProjects({ projects, maxParallel, load, now, resume }): Promise<{ chosen: { position, project, selection, defaultBranch, data }[], released: { project, issue }[], more: boolean }>`.

- [ ] **Step 1: Write the test helper**

`test/helpers/fake-fetch.mjs`:

```js
// A fetch stand-in that answers by method and URL pattern and records every call.
export function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    for (const h of handlers) {
      if (h.method === method && h.match.test(String(url))) {
        const out = typeof h.reply === 'function' ? h.reply(String(url), init) : h.reply;
        const status = out.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => out.body,
          text: async () => JSON.stringify(out.body ?? ''),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { fetchImpl, calls };
}
```

- [ ] **Step 2: Write the failing client test**

`test/github.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubClient } from '../harness/lib/github.mjs';
import { makeFetch } from './helpers/fake-fetch.mjs';

const issue = (n, labels = [], extra = {}) => ({ number: n, title: `T${n}`, body: `b${n}`, labels: labels.map((name) => ({ name, color: 'x' })), updated_at: '2026-10-31T00:00:00Z', ...extra });

test('openIssues drops pull requests, keeps only the needed fields and pages through results', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 1));
  const { fetchImpl, calls } = makeFetch([{
    method: 'GET',
    match: /\/repos\/a\/b\/issues\?state=open/,
    reply: (url) => ({ body: url.includes('page=1') ? [...page1.slice(0, 99), issue(500, [], { pull_request: {} })] : [issue(101, ['agent'])] }),
  }]);
  const client = githubClient({ token: 't', fetchImpl });
  const issues = await client.openIssues('a/b');
  assert.equal(issues.length, 100);
  assert.deepEqual(issues.at(-1), { number: 101, title: 'T101', body: 'b101', labels: [{ name: 'agent' }], updatedAt: '2026-10-31T00:00:00Z' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, 'Bearer t');
});

test('errors never contain the repository name', async () => {
  const { fetchImpl } = makeFetch([{ method: 'GET', match: /./, reply: { status: 500, body: {} } }]);
  const client = githubClient({ token: 't', fetchImpl });
  await assert.rejects(() => client.defaultBranch('zzsecret/name'), (e) => !/zzsecret/.test(e.message) && /500/.test(e.message));
});

test('openPrs marks cross-repository pull requests', async () => {
  const { fetchImpl } = makeFetch([{
    method: 'GET',
    match: /\/pulls\?state=open/,
    reply: { body: [
      { number: 1, head: { ref: 'agent/issue-3', repo: { full_name: 'a/b' } }, base: { repo: { full_name: 'a/b' } }, body: 'x' },
      { number: 2, head: { ref: 'agent/issue-4', repo: { full_name: 'fork/b' } }, base: { repo: { full_name: 'a/b' } }, body: 'y' },
      { number: 3, head: { ref: 'gone', repo: null }, base: { repo: { full_name: 'a/b' } }, body: 'z' },
    ] },
  }]);
  const prs = await githubClient({ token: 't', fetchImpl }).openPrs('a/b');
  assert.deepEqual(prs.map((p) => [p.headRefName, p.isCrossRepository]), [['agent/issue-3', false], ['agent/issue-4', true], ['gone', true]]);
});

test('closedMergedPrs keeps merged ones in the shape issueToClose reads', async () => {
  const { fetchImpl } = makeFetch([{
    method: 'GET',
    match: /\/pulls\?state=closed/,
    reply: { body: [
      { merged_at: '2026-10-30T00:00:00Z', head: { ref: 'agent/issue-3', repo: { full_name: 'a/b' } }, base: { repo: { full_name: 'a/b' } }, body: 'm' },
      { merged_at: null, head: { ref: 'agent/issue-4', repo: { full_name: 'a/b' } }, base: { repo: { full_name: 'a/b' } }, body: 'n' },
    ] },
  }]);
  const merged = await githubClient({ token: 't', fetchImpl }).closedMergedPrs('a/b');
  assert.deepEqual(merged, [{ merged: true, head: { ref: 'agent/issue-3', repo: { full_name: 'a/b' } }, base: { repo: { full_name: 'a/b' } }, body: 'm' }]);
});

test('setLabels removes (tolerating 404), then adds', async () => {
  const { fetchImpl, calls } = makeFetch([
    { method: 'DELETE', match: /labels\/agent$/, reply: { status: 200, body: [] } },
    { method: 'DELETE', match: /labels\/agent%3Awaiting$/, reply: { status: 404, body: {} } },
    { method: 'POST', match: /\/issues\/7\/labels$/, reply: { body: [] } },
  ]);
  await githubClient({ token: 't', fetchImpl }).setLabels('a/b', 7, { remove: ['agent', 'agent:waiting'], add: ['agent:running'] });
  assert.deepEqual(calls.map((c) => c.method), ['DELETE', 'DELETE', 'POST']);
  assert.deepEqual(calls[2].body, { labels: ['agent:running'] });
});

test('fileContent decodes base64 and returns null when the file is missing', async () => {
  const { fetchImpl } = makeFetch([
    { method: 'GET', match: /contents\/runner\/projects\.json/, reply: { body: { content: Buffer.from('{"x":1}').toString('base64'), encoding: 'base64' } } },
  ]);
  const c = githubClient({ token: 't', fetchImpl });
  assert.equal(await c.fileContent('a/b', 'runner/projects.json'), '{"x":1}');
  assert.equal(await c.fileContent('a/b', 'nope.json'), null);
});

test('putFile creates a file, and updates it with the current sha when it exists', async () => {
  let puts = [];
  const { fetchImpl } = makeFetch([
    { method: 'GET', match: /contents\/new\.json/, reply: { status: 404, body: {} } },
    { method: 'GET', match: /contents\/old\.json/, reply: { body: { sha: 'abc123', content: '', encoding: 'base64' } } },
    { method: 'PUT', match: /contents\//, reply: (url, init) => { puts.push(JSON.parse(init.body)); return { body: {} }; } },
  ]);
  const c = githubClient({ token: 't', fetchImpl });
  await c.putFile('a/b', 'new.json', '{"n":1}', 'add');
  await c.putFile('a/b', 'old.json', '{"n":2}', 'update');
  assert.equal(puts[0].sha, undefined);
  assert.equal(Buffer.from(puts[0].content, 'base64').toString(), '{"n":1}');
  assert.equal(puts[1].sha, 'abc123');
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test test/github.test.mjs`
Expected: FAIL, `Cannot find module '../harness/lib/github.mjs'`.

- [ ] **Step 4: Write the client**

`harness/lib/github.mjs`:

```js
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
      return (await pages(`/repos/${repo}/issues/${n}/comments`)).map((c) => ({ body: c.body ?? '' }));
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
```

- [ ] **Step 5: Run it to see it pass**

Run: `node --test test/github.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write the failing selection test**

`test/shared-select.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningState, STALE_MS, selectAcrossProjects, loadProject, closeMergedFor } from '../harness/lib/shared-select.mjs';
import { taskMarker } from '../harness/lib/queue.mjs';
import { githubClient } from '../harness/lib/github.mjs';
import { makeFetch } from './helpers/fake-fetch.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const issue = (number, task, labels, { plan = 'docs/p.md', updatedAt = iso(0) } = {}) => ({
  number, title: `T${task}`, body: `plan: ${plan}\ntask: ${task}`, labels: labels.map((name) => ({ name })), updatedAt,
});
const project = (repo) => ({ repo, tokenOwner: 'alice' });
const data = (issues, extra = {}) => ({ defaultBranch: 'main', issues, prs: [], ready: [], configText: null, ...extra });
const loadFrom = (table) => async (p) => table[p.repo];

test('runningState: a recent running label is busy, an old one is stale', () => {
  assert.deepEqual(runningState([issue(1, 1, ['agent:running'], { updatedAt: iso(60_000) })], NOW), { busy: true, stale: [] });
  assert.deepEqual(runningState([issue(1, 1, ['agent:running'], { updatedAt: iso(STALE_MS + 1) })], NOW), { busy: false, stale: [1] });
  assert.deepEqual(runningState([issue(1, 1, ['agent'])], NOW), { busy: false, stale: [] });
});

test('one task per project, in project order, up to the cap', async () => {
  const table = {
    'a/one': data([issue(1, 1, ['agent']), issue(2, 2, ['agent'])]),
    'a/two': data([issue(3, 1, ['agent'])]),
    'a/three': data([issue(4, 1, ['agent'])]),
  };
  const r = await selectAcrossProjects({ projects: ['a/one', 'a/two', 'a/three'].map(project), maxParallel: 2, load: loadFrom(table), now: NOW });
  assert.deepEqual(r.chosen.map((c) => [c.position, c.project.repo, c.selection.issue.number]), [[0, 'a/one', 1], [1, 'a/two', 3]]);
  assert.equal(r.more, true, 'a third project and a second task are still queued');
});

test('a project with a recent running task is left alone; nothing queued gives nothing', async () => {
  const table = {
    'a/one': data([issue(1, 1, ['agent:running'], { updatedAt: iso(1000) }), issue(2, 2, ['agent'])]),
    'a/two': data([issue(3, 1, ['agent:ready'])]),
  };
  const r = await selectAcrossProjects({ projects: ['a/one', 'a/two'].map(project), maxParallel: 3, load: loadFrom(table), now: NOW });
  assert.deepEqual(r.chosen, []);
  assert.equal(r.more, true, 'a/one still has a queued task behind its running one');
});

test('a stale running label is released as blocked, so the project does not freeze (review focus 3)', async () => {
  const stale = issue(1, 1, ['agent:running'], { updatedAt: iso(STALE_MS + 1) });
  const table = { 'a/one': data([stale, issue(2, 2, ['agent'])]) };
  const r = await selectAcrossProjects({ projects: [project('a/one')], maxParallel: 3, load: loadFrom(table), now: NOW });
  assert.deepEqual(r.released.map((x) => [x.project.repo, x.issue]), [['a/one', 1]]);
  assert.equal(r.chosen.length, 1);
  assert.match(r.chosen[0].selection.skip, /upstream task 1 blocked/, 'the stacked task waits behind the released one');
});

test('waiting tasks are only picked up when resuming (the scheduled run)', async () => {
  const table = { 'a/one': data([issue(1, 1, ['agent:waiting'])]) };
  const common = { projects: [project('a/one')], maxParallel: 3, load: loadFrom(table), now: NOW };
  assert.equal((await selectAcrossProjects({ ...common, resume: false })).chosen.length, 0);
  assert.equal((await selectAcrossProjects({ ...common, resume: true })).chosen.length, 1);
});

test('loadProject collects issues, PRs, ready comments, config and the default branch', async () => {
  const { fetchImpl } = makeFetch([
    { method: 'GET', match: /\/repos\/a\/b$/, reply: { body: { default_branch: 'trunk' } } },
    { method: 'GET', match: /\/issues\?state=open/, reply: { body: [
      { number: 1, title: 't', body: 'plan: p\ntask: 1', labels: [{ name: 'agent:ready' }], updated_at: iso(0) },
      { number: 2, title: 'u', body: 'x', labels: [], updated_at: iso(0) },
    ] } },
    { method: 'GET', match: /\/pulls\?state=open/, reply: { body: [] } },
    { method: 'GET', match: /\/issues\/1\/comments/, reply: { body: [{ body: 'hello' }] } },
    { method: 'GET', match: /contents\/agent\.config\.json\?ref=trunk/, reply: { body: { content: Buffer.from('{"k":1}').toString('base64'), encoding: 'base64' } } },
  ]);
  const d = await loadProject(githubClient({ token: 't', fetchImpl }), 'a/b');
  assert.equal(d.defaultBranch, 'trunk');
  assert.equal(d.issues.length, 2);
  assert.deepEqual(d.ready, [{ number: 1, body: 'plan: p\ntask: 1', comments: [{ body: 'hello' }] }]);
  assert.equal(d.configText, '{"k":1}');
});

test('closeMergedFor closes only open issues whose merged agent PR names them', async () => {
  const closed = [];
  const client = {
    closedMergedPrs: async () => [
      { merged: true, head: { ref: 'agent/issue-5', repo: { full_name: 'a/b' } }, base: { repo: { full_name: 'a/b' } }, body: taskMarker({ plan: 'p', task: 1, issue: 5 }) },
      { merged: true, head: { ref: 'agent/issue-6', repo: { full_name: 'a/b' } }, base: { repo: { full_name: 'a/b' } }, body: taskMarker({ plan: 'p', task: 2, issue: 6 }) },
      { merged: true, head: { ref: 'agent/issue-7', repo: { full_name: 'fork/b' } }, base: { repo: { full_name: 'a/b' } }, body: taskMarker({ plan: 'p', task: 3, issue: 7 }) },
    ],
    closeIssue: async (repo, n) => closed.push([repo, n]),
  };
  const result = await closeMergedFor({ repo: 'a/b', client, issues: [issue(5, 1, []), issue(7, 3, [])] });
  assert.deepEqual(result, [5]);
  assert.deepEqual(closed, [['a/b', 5]]);
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `node --test test/shared-select.test.mjs`
Expected: FAIL, `Cannot find module '../harness/lib/shared-select.mjs'`.

- [ ] **Step 8: Write the selection module**

`harness/lib/shared-select.mjs`:

```js
import { selectNext } from './queue.mjs';
import { issueToClose } from './merged.mjs';

// A task that has carried `agent:running` for longer than a run can last is a crashed run.
export const STALE_MS = 3 * 60 * 60 * 1000;

const names = (i) => i.labels.map((l) => l.name);
const has = (i, name) => names(i).includes(name);
const queued = (i, resume) => !has(i, 'agent:running') && (has(i, 'agent') || (resume && has(i, 'agent:waiting')));

export function runningState(issues, now) {
  const running = issues.filter((i) => has(i, 'agent:running'));
  const stale = running.filter((i) => now - Date.parse(i.updatedAt) > STALE_MS).map((i) => i.number);
  return { busy: running.length > stale.length, stale };
}

export async function loadProject(client, repo) {
  const defaultBranch = await client.defaultBranch(repo);
  const [issues, prs, configText] = await Promise.all([
    client.openIssues(repo),
    client.openPrs(repo),
    client.fileContent(repo, 'agent.config.json', defaultBranch),
  ]);
  const ready = [];
  for (const i of issues.filter((x) => has(x, 'agent:ready'))) {
    ready.push({ number: i.number, body: i.body, comments: await client.comments(repo, i.number) });
  }
  return { defaultBranch, issues, prs, ready, configText };
}

// Stacked tasks merged into their parent branch never close their issue on their own.
export async function closeMergedFor({ repo, client, issues }) {
  const open = new Set(issues.map((i) => i.number));
  const closed = [];
  for (const pull_request of await client.closedMergedPrs(repo)) {
    const n = issueToClose({ pull_request });
    if (n !== null && open.has(n)) {
      await client.closeIssue(repo, n);
      closed.push(n);
    }
  }
  return closed;
}

// At most one task per project and at most `maxParallel` projects. A project with a live
// running task is skipped, so two runs of one project never overlap.
export async function selectAcrossProjects({ projects, maxParallel, load, now, resume = false }) {
  const chosen = [];
  const released = [];
  let more = false;
  for (const [position, project] of projects.entries()) {
    const data = await load(project);
    if (!data) continue;
    const { busy, stale } = runningState(data.issues, now);
    for (const issue of stale) released.push({ project, issue });
    const staleSet = new Set(stale);
    // A released task counts as blocked, so later tasks of its plan wait behind it.
    const issues = data.issues.map((i) => (staleSet.has(i.number)
      ? { ...i, labels: [...i.labels.filter((l) => l.name !== 'agent:running'), { name: 'agent:blocked' }] }
      : i));
    // Without `resume`, waiting tasks stay parked; selectNext would otherwise pick them up.
    const visible = resume ? issues : issues.map((i) => (has(i, 'agent:waiting') ? { ...i, labels: i.labels.filter((l) => l.name !== 'agent:waiting') } : i));
    const waiting = visible.filter((i) => queued(i, resume)).length;
    if (busy || chosen.length >= maxParallel) {
      more ||= waiting > 0;
      continue;
    }
    const selection = selectNext({ issues: visible, prs: data.prs, defaultBranch: data.defaultBranch, ready: data.ready });
    if (!selection.issue) continue;
    chosen.push({ position, project, selection, defaultBranch: data.defaultBranch, data });
    more ||= waiting > 1;
  }
  return { chosen, released, more };
}
```

- [ ] **Step 9: Run it to see it pass, then the whole suite**

Run: `node --test test/shared-select.test.mjs && npm test`
Expected: the new file passes (7 tests) and the suite stays green.

- [ ] **Step 10: Commit**

```bash
git add harness/lib/github.mjs harness/lib/shared-select.mjs test/helpers/fake-fetch.mjs test/github.test.mjs test/shared-select.test.mjs
git commit -m "feat: GitHub client and task selection across projects"
```

---

### Task 4: The select entry script

**Files:**
- Create: `harness/lib/shared-run.mjs`, `harness/shared-select.mjs`
- Test: `test/shared-run.test.mjs`

**Interfaces:**
- Consumes: `parseProjects` (Task 1), `parseTokenMap`, `resolveToken`, `makeProbe` (Task 2), `githubClient`, `loadProject`, `closeMergedFor`, `selectAcrossProjects` (Task 3), `loadConfig` from `harness/lib/config.mjs`.
- Produces: `runSharedSelect({ projectsText, tokensText, outDir, fetchImpl, now, resume }): Promise<{ count: number, more: boolean, skippedNoToken: number }>` and writes `<outDir>/selections.json`, an array of entries:
  `{ index, repo, tokenOwner, tokenIndex, tokenKind, defaultBranch, selection, target: null | { repo, path, ref, tokenOwner, tokenIndex, tokenKind } | { repo, path, ref, error } }`.
- Entry script `harness/shared-select.mjs --store-repo <o/n> --projects-path <p> --out <dir>`, env `STORE_TOKEN`, `RUNNER_TOKENS`, optional `EVENT_NAME`; prints only `count=`, `more=`, `matrix=` lines.

- [ ] **Step 1: Write the failing test**

`test/shared-run.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSharedSelect } from '../harness/lib/shared-run.mjs';
import { makeFetch } from './helpers/fake-fetch.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const cfg = (extra = {}) => JSON.stringify({ install: 'npm ci', checks: { test: 'npm test' }, ...extra });
const repoHandlers = (repo, { issues, config = cfg(), push = true, branch = 'main' }) => [
  { method: 'GET', match: new RegExp(`/repos/${repo}$`), reply: (url, init) => ({ body: { default_branch: branch, permissions: { pull: true, push: init.headers.authorization === 'Bearer ghp_ok' ? push : false } } }) },
  { method: 'GET', match: new RegExp(`/repos/${repo}/issues\\?state=open`), reply: { body: issues } },
  { method: 'GET', match: new RegExp(`/repos/${repo}/pulls\\?state=open`), reply: { body: [] } },
  { method: 'GET', match: new RegExp(`/repos/${repo}/pulls\\?state=closed`), reply: { body: [] } },
  { method: 'GET', match: new RegExp(`/repos/${repo}/contents/agent\\.config\\.json`), reply: { body: { content: Buffer.from(config).toString('base64'), encoding: 'base64' } } },
  { method: 'PUT', match: /./, reply: { body: {} } },
  { method: 'POST', match: new RegExp(`/repos/${repo}/issues/\\d+/labels`), reply: { body: [] } },
  { method: 'POST', match: new RegExp(`/repos/${repo}/issues/\\d+/comments`), reply: { body: {} } },
  { method: 'DELETE', match: new RegExp(`/repos/${repo}/issues/\\d+/labels/`), reply: { body: [] } },
];
const gi = (number, task, labels = ['agent'], updated = '2026-10-31T11:59:00Z') => ({ number, title: `T${task}`, body: `plan: docs/p.md\ntask: ${task}`, labels: labels.map((name) => ({ name })), updated_at: updated });
const out = () => mkdtempSync(join(tmpdir(), 'sel-'));
const tokens = JSON.stringify({ alice: ['github_pat_no', 'ghp_ok'] });

test('claims one task per project, resolves tokens and writes entries with indices', async () => {
  const { fetchImpl, calls } = makeFetch([...repoHandlers('alice/one', { issues: [gi(1, 1), gi(2, 2)] }), ...repoHandlers('alice/two', { issues: [gi(9, 1)] })]);
  const dir = out();
  const r = await runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'alice/one' }, { repo: 'alice/two' }] }), tokensText: tokens, outDir: dir, fetchImpl, now: NOW });
  assert.deepEqual(r, { count: 2, more: true, skippedNoToken: 0 });
  const entries = JSON.parse(readFileSync(join(dir, 'selections.json'), 'utf8'));
  assert.deepEqual(entries.map((e) => [e.index, e.repo, e.tokenIndex, e.tokenKind, e.selection.issue.number]), [[0, 'alice/one', 1, 'classic', 1], [1, 'alice/two', 1, 'classic', 9]]);
  const claims = calls.filter((c) => c.method === 'POST' && /labels$/.test(c.url));
  assert.deepEqual(claims.map((c) => c.body.labels), [['agent:running'], ['agent:running']]);
});

test('a project no token can reach is skipped and counted, with nothing printed (review focus 1)', async () => {
  const printed = [];
  const orig = console.log; const origErr = console.error;
  console.log = (...a) => printed.push(a.join(' ')); console.error = (...a) => printed.push(a.join(' '));
  try {
    const { fetchImpl } = makeFetch([...repoHandlers('alice/one', { issues: [gi(1, 1)], push: false })]);
    const r = await runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'alice/one' }] }), tokensText: tokens, outDir: out(), fetchImpl, now: NOW });
    assert.deepEqual(r, { count: 0, more: false, skippedNoToken: 1 });
  } finally { console.log = orig; console.error = origErr; }
  assert.deepEqual(printed, []);
});

test('a configured target gets its own token entry; an unreachable one records an error', async () => {
  const config = cfg({ target: { repo: 'org/code', path: 'target' } });
  const { fetchImpl } = makeFetch([
    ...repoHandlers('alice/one', { issues: [gi(1, 1)], config }),
    { method: 'GET', match: /\/repos\/org\/code$/, reply: (url, init) => (init.headers.authorization === 'Bearer ghp_org' ? { body: { permissions: { pull: true, push: true } } } : { status: 404, body: {} }) },
  ]);
  const projectsText = JSON.stringify({ projects: [{ repo: 'alice/one', targetTokenOwner: 'org' }] });
  const dir = out();
  await runSharedSelect({ projectsText, tokensText: JSON.stringify({ alice: ['ghp_ok'], org: ['ghp_org'] }), outDir: dir, fetchImpl, now: NOW });
  const [ok] = JSON.parse(readFileSync(join(dir, 'selections.json'), 'utf8'));
  assert.deepEqual(ok.target, { repo: 'org/code', path: 'target', ref: '', tokenOwner: 'org', tokenIndex: 0, tokenKind: 'classic' });

  const dir2 = out();
  await runSharedSelect({ projectsText, tokensText: JSON.stringify({ alice: ['ghp_ok'], org: ['ghp_wrong'] }), outDir: dir2, fetchImpl, now: NOW });
  const [bad] = JSON.parse(readFileSync(join(dir2, 'selections.json'), 'utf8'));
  assert.deepEqual(bad.target, { repo: 'org/code', path: 'target', ref: '', error: 'no usable token' });
});

test('a crashed run is released and its stacked task waits; waiting tasks need the resume flag', async () => {
  const stale = gi(1, 1, ['agent:running'], '2026-10-31T01:00:00Z');
  const { fetchImpl, calls } = makeFetch(repoHandlers('alice/one', { issues: [stale, gi(2, 2), gi(3, 1, ['agent:waiting'])] }));
  const dir = out();
  const r = await runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'alice/one' }] }), tokensText: tokens, outDir: dir, fetchImpl, now: NOW, resume: false });
  assert.equal(r.count, 1);
  const [e] = JSON.parse(readFileSync(join(dir, 'selections.json'), 'utf8'));
  assert.equal(e.selection.issue.number, 2);
  assert.match(e.selection.skip, /blocked/);
  const blocked = calls.find((c) => c.method === 'POST' && c.body?.labels?.includes('agent:blocked'));
  assert.ok(blocked, 'the stale task was labelled blocked');
});

test('bad input is rejected before any request is made', async () => {
  const { fetchImpl, calls } = makeFetch([]);
  await assert.rejects(() => runSharedSelect({ projectsText: 'nope', tokensText: tokens, outDir: out(), fetchImpl, now: NOW }), /projects/);
  await assert.rejects(() => runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'a/b' }] }), tokensText: 'nope', outDir: out(), fetchImpl, now: NOW }), /tokens/);
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/shared-run.test.mjs`
Expected: FAIL, `Cannot find module '../harness/lib/shared-run.mjs'`.

- [ ] **Step 3: Write the implementation**

`harness/lib/shared-run.mjs`:

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjects } from './projects.mjs';
import { parseTokenMap, resolveToken, makeProbe } from './tokens.mjs';
import { githubClient } from './github.mjs';
import { loadProject, closeMergedFor, selectAcrossProjects } from './shared-select.mjs';
import { loadConfig } from './config.mjs';

// The same expression `target-info` uses for the target checkout ref.
const targetRef = (selection) => selection.targets?.superBranch ?? selection.targetBase ?? '';

export async function runSharedSelect({ projectsText, tokensText, outDir, fetchImpl = fetch, now = Date.now(), resume = false }) {
  const { projects, maxParallel } = parseProjects(projectsText);
  const tokenMap = parseTokenMap(tokensText);
  const probe = makeProbe(fetchImpl);

  const resolved = new Map();
  const clients = new Map();
  const usable = [];
  let skippedNoToken = 0;
  for (const p of projects) {
    const list = tokenMap[p.tokenOwner];
    const r = list ? await resolveToken({ repo: p.repo, tokens: list, needsWrite: true, probe }) : null;
    if (!r) {
      skippedNoToken += 1;
      continue;
    }
    resolved.set(p.repo, { tokenOwner: p.tokenOwner, tokenIndex: r.index, tokenKind: r.kind });
    clients.set(p.repo, githubClient({ token: list[r.index], fetchImpl }));
    usable.push(p);
  }

  const load = async (p) => {
    const client = clients.get(p.repo);
    const data = await loadProject(client, p.repo);
    const closed = new Set(await closeMergedFor({ repo: p.repo, client, issues: data.issues }));
    return { ...data, issues: data.issues.filter((i) => !closed.has(i.number)) };
  };
  const { chosen, released, more } = await selectAcrossProjects({ projects: usable, maxParallel, load, now, resume });

  for (const { project, issue } of released) {
    const client = clients.get(project.repo);
    await client.setLabels(project.repo, issue, { remove: ['agent:running'], add: ['agent:blocked'] });
    await client.comment(project.repo, issue, '⛔ **BLOCKED** (runner)\n\n- the previous run did not finish (no result was recorded)\n\nTo retry: remove `agent:blocked` and add `agent`.');
  }

  const entries = [];
  for (const [index, c] of chosen.entries()) {
    const { repo } = c.project;
    const client = clients.get(repo);
    await client.setLabels(repo, c.selection.issue.number, { remove: ['agent', 'agent:waiting'], add: ['agent:running'] });
    let target = null;
    try {
      const t = c.data.configText ? loadConfig(c.data.configText).target : null;
      if (t) {
        const owner = c.project.targetTokenOwner ?? t.repo.split('/')[0];
        const list = tokenMap[owner];
        const r = list ? await resolveToken({ repo: t.repo, tokens: list, needsWrite: true, probe }) : null;
        const base = { repo: t.repo, path: t.path, ref: targetRef(c.selection) };
        target = r ? { ...base, tokenOwner: owner, tokenIndex: r.index, tokenKind: r.kind } : { ...base, error: 'no usable token' };
      }
    } catch {
      // an invalid config is reported by the run itself
    }
    entries.push({ index, repo, ...resolved.get(repo), defaultBranch: c.defaultBranch, selection: c.selection, target });
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'selections.json'), `${JSON.stringify(entries, null, 2)}\n`);
  return { count: entries.length, more, skippedNoToken };
}
```

`harness/shared-select.mjs`:

```js
#!/usr/bin/env node
// Entry for the runner's select job. Prints only counts and indices: this runs where
// logs are public, and project names must not reach them.
import { parseArgs } from 'node:util';
import { githubClient } from './lib/github.mjs';
import { runSharedSelect } from './lib/shared-run.mjs';

const { values } = parseArgs({
  options: { 'store-repo': { type: 'string' }, 'projects-path': { type: 'string' }, out: { type: 'string' } },
});
const need = (name, v) => {
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
};
try {
  const store = githubClient({ token: need('STORE_TOKEN', process.env.STORE_TOKEN) });
  const projectsText = await store.fileContent(need('--store-repo', values['store-repo']), need('--projects-path', values['projects-path']));
  if (projectsText === null) throw new Error('the project list was not found');
  const r = await runSharedSelect({
    projectsText,
    tokensText: need('RUNNER_TOKENS', process.env.RUNNER_TOKENS),
    outDir: need('--out', values.out),
    resume: process.env.EVENT_NAME === 'schedule',
  });
  process.stdout.write(`count=${r.count}\nmore=${r.more}\nmatrix=${JSON.stringify([...Array(r.count).keys()])}\n`);
} catch (e) {
  console.error(`select failed: ${e.message}`);
  process.exit(1);
}
```

- [ ] **Step 4: Run it to see it pass, then the whole suite**

Run: `node --test test/shared-run.test.mjs && npm test`
Expected: PASS, 5 tests; suite green.

- [ ] **Step 5: Commit**

```bash
git add harness/lib/shared-run.mjs harness/shared-select.mjs test/shared-run.test.mjs
git commit -m "feat: runner select entry across private projects"
```

---

### Task 5: Encryption and the entry commands

**Files:**
- Create: `harness/lib/crypt.mjs`
- Modify: `harness/cli.mjs` (add `encrypt`, `decrypt`, `shared-entry`; add the options `dir`, `in`, `index`, `selections`)
- Test: `test/crypt.test.mjs`, `test/shared-entry.test.mjs`

**Interfaces:**
- Produces:
  - `encryptDir(dir, outFile, secret): Promise<void>`, `decryptToDir(inFile, dir, secret): Promise<void>`. File layout: `AHE1` (4 bytes) | salt (16) | iv (12) | ciphertext | auth tag (16).
  - CLI: `cli.mjs encrypt --dir <d> --out <f>`, `cli.mjs decrypt --in <f> --dir <d>` (key from env `RUN_KEY`); `cli.mjs shared-entry --selections <f> --index <n> --out <d>` writing `entry.json`, `selection.json`, `issue.json` and printing `skipped=`, `base=`, `default=`, `issue=`.

- [ ] **Step 1: Write the failing encryption test**

`test/crypt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptDir, decryptToDir } from '../harness/lib/crypt.mjs';

const KEY = 'a-long-enough-test-secret-1234';
const tmp = () => mkdtempSync(join(tmpdir(), 'crypt-'));
function fixture() {
  const dir = tmp();
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'report.txt'), 'PLAINTEXT-MARKER-12345 the quick brown fox\n');
  writeFileSync(join(dir, 'nested', 'a.json'), '{"k":"PLAINTEXT-MARKER-12345"}');
  return dir;
}

test('round trip restores every file', async () => {
  const src = fixture();
  const enc = join(tmp(), 'out.enc');
  await encryptDir(src, enc, KEY);
  const dest = tmp();
  await decryptToDir(enc, dest, KEY);
  assert.equal(readFileSync(join(dest, 'report.txt'), 'utf8'), readFileSync(join(src, 'report.txt'), 'utf8'));
  assert.equal(readFileSync(join(dest, 'nested', 'a.json'), 'utf8'), '{"k":"PLAINTEXT-MARKER-12345"}');
});

test('the encrypted file does not contain the plaintext', async () => {
  const enc = join(tmp(), 'out.enc');
  await encryptDir(fixture(), enc, KEY);
  const bytes = readFileSync(enc);
  assert.ok(!bytes.includes('PLAINTEXT-MARKER-12345'));
  assert.ok(!bytes.includes('report.txt'));
});

test('a wrong key and a damaged file are both refused, and nothing is unpacked', async () => {
  const enc = join(tmp(), 'out.enc');
  await encryptDir(fixture(), enc, KEY);
  const wrong = tmp();
  await assert.rejects(() => decryptToDir(enc, wrong, 'another-long-enough-secret-9876'), /decryption failed/);
  assert.ok(!existsSync(join(wrong, 'report.txt')));
  const bytes = readFileSync(enc);
  bytes[bytes.length - 40] ^= 0xff;
  const damaged = join(tmp(), 'bad.enc');
  writeFileSync(damaged, bytes);
  const dest = tmp();
  await assert.rejects(() => decryptToDir(damaged, dest, KEY), /decryption failed/);
  assert.ok(!existsSync(join(dest, 'report.txt')));
});

test('a short or missing key is refused, and errors never echo the key', async () => {
  const enc = join(tmp(), 'out.enc');
  await assert.rejects(() => encryptDir(fixture(), enc, 'zzkey'), (e) => !/zzkey/.test(e.message));
  await assert.rejects(() => encryptDir(fixture(), enc, undefined), /key/);
});

test('symbolic links are refused, and the output cannot sit inside the directory', async () => {
  const dir = fixture();
  symlinkSync('/etc/hosts', join(dir, 'link'));
  await assert.rejects(() => encryptDir(dir, join(tmp(), 'o.enc'), KEY), /symbolic link/);
  const clean = fixture();
  await assert.rejects(() => encryptDir(clean, join(clean, 'o.enc'), KEY), /inside/);
});

test('a file that is not an encrypted run file is refused', async () => {
  const f = join(tmp(), 'x.enc');
  writeFileSync(f, Buffer.alloc(100));
  await assert.rejects(() => decryptToDir(f, tmp(), KEY), /not an encrypted run file/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/crypt.test.mjs`
Expected: FAIL, `Cannot find module '../harness/lib/crypt.mjs'`.

- [ ] **Step 3: Write the implementation**

`harness/lib/crypt.mjs`:

```js
// Encrypts a directory for upload to a place strangers can read. tar | AES-256-GCM with a
// key derived from a shared secret. The auth tag is the last 16 bytes and is checked before
// anything is unpacked, so a damaged or forged file extracts nothing.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  appendFileSync, closeSync, createReadStream, createWriteStream, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const MAGIC = Buffer.from('AHE1');
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEADER = MAGIC.length + SALT + IV;

const key = (secret, salt) => scryptSync(secret, salt, 32);

function requireSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('encryption key missing or too short (16+ characters)');
}

function assertNoSymlinks(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error('refusing to archive a symbolic link');
    if (st.isDirectory()) assertNoSymlinks(p);
  }
}

const exited = (child, message) => new Promise((resolveP, reject) => {
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolveP() : reject(new Error(message))));
});

export async function encryptDir(dir, outFile, secret) {
  requireSecret(secret);
  const root = resolve(dir);
  if (resolve(outFile).startsWith(root + sep)) throw new Error('the output file must not be inside the directory it archives');
  assertNoSymlinks(root);
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key(secret, salt), iv);
  writeFileSync(outFile, Buffer.concat([MAGIC, salt, iv]));
  const tar = spawn('tar', ['-cf', '-', '-C', root, '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await Promise.all([
    pipeline(tar.stdout, cipher, createWriteStream(outFile, { flags: 'a' })),
    exited(tar, 'archiving failed'),
  ]);
  appendFileSync(outFile, cipher.getAuthTag());
}

export async function decryptToDir(inFile, dir, secret) {
  requireSecret(secret);
  const size = statSync(inFile).size;
  if (size <= HEADER + TAG) throw new Error('not an encrypted run file');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  const fd = openSync(inFile, 'r');
  try {
    readSync(fd, head, 0, HEADER, 0);
    readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    closeSync(fd);
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted run file');
  const decipher = createDecipheriv('aes-256-gcm', key(secret, head.subarray(MAGIC.length, MAGIC.length + SALT)), head.subarray(MAGIC.length + SALT));
  decipher.setAuthTag(tag);
  const scratch = mkdtempSync(join(tmpdir(), 'ahe-'));
  const archive = join(scratch, 'archive.tar');
  try {
    try {
      await pipeline(createReadStream(inFile, { start: HEADER, end: size - TAG - 1 }), decipher, createWriteStream(archive));
    } catch {
      throw new Error('decryption failed (wrong key or damaged file)');
    }
    mkdirSync(dir, { recursive: true });
    await exited(spawn('tar', ['-xf', archive, '-C', dir, '--no-same-owner'], { stdio: 'ignore' }), 'unpacking failed');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/crypt.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing entry-command test**

`test/shared-entry.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = join(import.meta.dirname, '..', 'harness', 'cli.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'entry-'));
const run = (args, env = {}) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

const entries = [
  { index: 0, repo: 'a/one', tokenOwner: 'a', tokenIndex: 0, tokenKind: 'classic', defaultBranch: 'main', target: null, selection: { issue: { number: 4, title: 'T', body: 'b', labels: [] }, plan: 'p', task: 1, base: 'agent/issue-3', skip: null } },
  { index: 1, repo: 'a/two', tokenOwner: 'a', tokenIndex: 0, tokenKind: 'classic', defaultBranch: 'trunk', target: null, selection: { issue: { number: 8, title: 'U', body: 'c', labels: [] }, plan: 'p', task: 2, base: 'trunk', skip: 'upstream task 1 blocked (#7)' } },
];

test('shared-entry writes the entry files and prints only neutral outputs', () => {
  const dir = tmp();
  const sel = join(dir, 'selections.json');
  writeFileSync(sel, JSON.stringify(entries));
  const out = join(dir, 'agent');
  const r = run(['shared-entry', '--selections', sel, '--index', '1', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'skipped=true\nbase=trunk\ndefault=trunk\nissue=8\n');
  assert.ok(!/a\/two/.test(r.stdout + r.stderr));
  assert.equal(JSON.parse(readFileSync(join(out, 'entry.json'), 'utf8')).repo, 'a/two');
  assert.equal(JSON.parse(readFileSync(join(out, 'issue.json'), 'utf8')).number, 8);
  assert.equal(JSON.parse(readFileSync(join(out, 'selection.json'), 'utf8')).task, 2);
});

test('shared-entry refuses an index that is not there, without naming anything', () => {
  const dir = tmp();
  const sel = join(dir, 'selections.json');
  writeFileSync(sel, JSON.stringify(entries));
  const r = run(['shared-entry', '--selections', sel, '--index', '5', '--out', join(dir, 'o')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such selection/);
});

test('encrypt and decrypt take the key from RUN_KEY and never print it', () => {
  const src = tmp();
  writeFileSync(join(src, 'a.txt'), 'hello');
  const holder = tmp();
  const enc = join(holder, 'o.enc');
  const env = { RUN_KEY: 'a-long-enough-test-secret-1234' };
  const e = run(['encrypt', '--dir', src, '--out', enc], env);
  assert.equal(e.status, 0, e.stderr);
  const dest = join(holder, 'dest');
  const d = run(['decrypt', '--in', enc, '--dir', dest], env);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'hello');
  const bad = run(['decrypt', '--in', enc, '--dir', join(holder, 'd2')], { RUN_KEY: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' });
  assert.equal(bad.status, 1);
  assert.ok(!/zzzzzz/.test(bad.stderr + bad.stdout));
  const missing = run(['encrypt', '--dir', src, '--out', join(holder, 'x.enc')], { RUN_KEY: '' });
  assert.equal(missing.status, 1);
  assert.ok(!existsSync(join(holder, 'd2', 'a.txt')));
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `node --test test/shared-entry.test.mjs`
Expected: FAIL (the commands are unknown: exit code 2 with the usage text).

- [ ] **Step 7: Wire the commands into `harness/cli.mjs`**

Add the import after the existing imports:

```js
import { encryptDir, decryptToDir } from './lib/crypt.mjs';
```

Add three lines to the `USAGE` string (before the closing backtick, keep the same style):

```
  cli.mjs shared-entry --selections <f> --index <n> --out <dir>
  cli.mjs encrypt --dir <d> --out <f>        (key in env RUN_KEY)
  cli.mjs decrypt --in <f> --dir <d>         (key in env RUN_KEY)
```

Add to the `parseArgs` `options`:

```js
      selections: { type: 'string' }, index: { type: 'string' }, dir: { type: 'string' }, in: { type: 'string' },
```

Add these cases before `default:`:

```js
  case 'shared-entry': {
    const entry = read(values.selections)[Number(values.index)];
    if (!entry) {
      console.error('no such selection');
      process.exit(1);
    }
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'entry.json'), `${JSON.stringify(entry, null, 2)}\n`);
    writeFileSync(join(values.out, 'selection.json'), `${JSON.stringify(entry.selection, null, 2)}\n`);
    writeFileSync(join(values.out, 'issue.json'), `${JSON.stringify(entry.selection.issue, null, 2)}\n`);
    process.stdout.write(`skipped=${entry.selection.skip ? 'true' : 'false'}\nbase=${entry.selection.base}\ndefault=${entry.defaultBranch}\nissue=${entry.selection.issue.number}\n`);
    break;
  }
  case 'encrypt':
  case 'decrypt':
    try {
      if (command === 'encrypt') await encryptDir(values.dir, values.out, process.env.RUN_KEY);
      else await decryptToDir(values.in, values.dir, process.env.RUN_KEY);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    break;
```

- [ ] **Step 8: Run it to see it pass, then the whole suite**

Run: `node --test test/shared-entry.test.mjs && npm test`
Expected: PASS, 3 tests; suite green.

- [ ] **Step 9: Commit**

```bash
git add harness/lib/crypt.mjs harness/cli.mjs test/crypt.test.mjs test/shared-entry.test.mjs
git commit -m "feat: encrypt run output and read a selection entry"
```

---

### Task 6: Neutral-name lint and leak scan

**Files:**
- Create: `harness/lib/neutral.mjs`, `harness/lib/leak.mjs`
- Modify: `harness/cli.mjs` (add `leak-scan`, option `blocklist`, `root`, `file` as multiple)
- Test: `test/neutral.test.mjs`, `test/leak.test.mjs`

**Interfaces:**
- Produces:
  - `lintNeutralNames(yamlText): { line: number, expression: string }[]`. Flags any `${{ }}` in a `name:`, `run-name:` or `group:` line that is not one of `strategy.job-index`, `matrix.index`, `github.run_number`, `github.run_id`.
  - `parseBlocklist(text): string[]`, `scanText(path, text, terms): { path, line }[]`, `scanDir(root, terms): { path, line }[]` (a file whose name matches is reported with line `0`).
  - CLI `cli.mjs leak-scan --blocklist <f> [--root <d>]... [--file <f>]...`: prints `path:line` for each hit and exits 1; prints nothing and exits 0 when clean. It never prints a matched term.

- [ ] **Step 1: Write the failing tests**

`test/neutral.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintNeutralNames } from '../harness/lib/neutral.mjs';

test('index-only expressions in names and groups pass', () => {
  const y = [
    'run-name: run',
    'jobs:',
    '  run:',
    '    name: run (${{ matrix.index }})',
    '    concurrency:',
    '      group: selection',
    '    steps:',
    '      - name: Upload',
    '        with:',
    '          name: output-${{ matrix.index }}',
    '      - name: Round ${{ github.run_number }}',
  ].join('\n');
  assert.deepEqual(lintNeutralNames(y), []);
});

test('anything that can carry project text is flagged with its line', () => {
  const y = [
    'name: run ${{ github.repository }}',
    'jobs:',
    '  a:',
    '    name: ${{ needs.select.outputs.repo }}',
    '    concurrency:',
    '      group: ${{ github.event.issue.title }}',
    '      cancel-in-progress: false',
    '    steps:',
    '      - name: ${{ matrix.repo }}',
  ].join('\n');
  assert.deepEqual(lintNeutralNames(y).map((v) => [v.line, v.expression]), [
    [1, 'github.repository'], [4, 'needs.select.outputs.repo'], [6, 'github.event.issue.title'], [9, 'matrix.repo'],
  ]);
});

test('expressions outside name-like keys are not this lint\'s business', () => {
  assert.deepEqual(lintNeutralNames('env:\n  REPO: ${{ github.repository }}\nrun: echo ${{ github.repository }}'), []);
});
```

`test/leak.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseBlocklist, scanText, scanDir } from '../harness/lib/leak.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'leak-'));

test('parseBlocklist lowercases, drops comments, blanks and very short terms, and de-duplicates', () => {
  assert.deepEqual(parseBlocklist('# names\nAcmeCorp\n\nacmecorp\nab\n  Project-X  \n'), ['acmecorp', 'project-x']);
});

test('scanText reports lines, case-insensitively, without the term', () => {
  const hits = scanText('f.md', 'clean\nsee AcmeCorp here\nclean', ['acmecorp']);
  assert.deepEqual(hits, [{ path: 'f.md', line: 2 }]);
});

test('scanDir walks files, skips .git and node_modules, and flags a matching file name', () => {
  const root = tmp();
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'docs', 'a.md'), 'nothing\nmentions project-x\n');
  writeFileSync(join(root, '.git', 'cfg'), 'project-x');
  writeFileSync(join(root, 'node_modules', 'm.js'), 'project-x');
  writeFileSync(join(root, 'project-x-notes.txt'), 'harmless');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 112, 114, 111, 106, 101, 99, 116, 45, 120]));
  const hits = scanDir(root, ['project-x']);
  assert.deepEqual(hits.map((h) => [h.path, h.line]).sort(), [['docs/a.md', 2], ['project-x-notes.txt', 0]]);
});

test('the CLI exits 1 on a hit, prints no term, and exits 0 when clean', () => {
  const root = tmp();
  const bl = join(tmp(), 'blocklist.txt');
  writeFileSync(bl, 'zzsecretname\n');
  writeFileSync(join(root, 'x.md'), 'ok\nzzsecretname\n');
  const cli = join(import.meta.dirname, '..', 'harness', 'cli.mjs');
  const bad = spawnSync('node', [cli, 'leak-scan', '--blocklist', bl, '--root', root], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, 'x.md:2\n');
  assert.ok(!/zzsecretname/.test(bad.stdout + bad.stderr));
  writeFileSync(join(root, 'x.md'), 'ok\n');
  const ok = spawnSync('node', [cli, 'leak-scan', '--blocklist', bl, '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/neutral.test.mjs test/leak.test.mjs`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementations**

`harness/lib/neutral.mjs`:

```js
// A runner workflow must not let project text into anything a stranger can read: run names,
// job and step names, artifact names and concurrency groups. Only indices and run counters
// may be interpolated there.
const KEYED = /^\s*(?:-\s+)?(name|run-name|group):\s*(.*)$/;
const EXPR = /\$\{\{([^}]*)\}\}/g;
const ALLOWED = /^(?:strategy\.job-index|matrix\.index|github\.run_number|github\.run_id)$/;

export function lintNeutralNames(text) {
  const bad = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const m = KEYED.exec(line);
    if (!m) return;
    for (const e of m[2].matchAll(EXPR)) {
      const expression = e[1].trim();
      if (!ALLOWED.test(expression)) bad.push({ line: i + 1, expression });
    }
  });
  return bad;
}
```

`harness/lib/leak.mjs`:

```js
// Finds project names where they must not be. The blocklist is private and is only ever read
// at scan time. Hits carry a path and a line, never the term.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['.git', 'node_modules']);

export function parseBlocklist(text) {
  const terms = String(text).split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#') && l.length >= 3);
  return [...new Set(terms)];
}

export function scanText(path, text, terms) {
  const hits = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const low = line.toLowerCase();
    if (terms.some((t) => low.includes(t))) hits.push({ path, line: i + 1 });
  });
  return hits;
}

export function scanDir(root, terms, { maxBytes = 1_000_000 } = {}) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const rel = relative(root, full);
      const st = statSync(full);
      if (terms.some((t) => name.toLowerCase().includes(t))) hits.push({ path: rel, line: 0 });
      if (st.isDirectory()) walk(full);
      else if (st.size <= maxBytes) {
        const buf = readFileSync(full);
        if (!buf.includes(0)) hits.push(...scanText(rel, buf.toString('utf8'), terms));
      }
    }
  };
  walk(root);
  return hits;
}
```

- [ ] **Step 4: Wire `leak-scan` into `harness/cli.mjs`**

Add imports:

```js
import { parseBlocklist, scanDir, scanText } from './lib/leak.mjs';
```

Add to `USAGE`:

```
  cli.mjs leak-scan --blocklist <f> [--root <d>]... [--file <f>]...
```

Change the `parseArgs` call so it accepts repeats for two options: add to `options`

```js
      blocklist: { type: 'string' }, root: { type: 'string', multiple: true }, file: { type: 'string', multiple: true },
```

Add the case before `default:`:

```js
  case 'leak-scan': {
    const terms = parseBlocklist(readFileSync(values.blocklist, 'utf8'));
    const hits = [
      ...(values.root ?? []).flatMap((r) => scanDir(r, terms)),
      ...(values.file ?? []).flatMap((f) => scanText(f, readFileSync(f, 'utf8'), terms)),
    ];
    for (const h of hits) process.stdout.write(`${h.path}:${h.line}\n`);
    if (hits.length > 0) process.exit(1);
    break;
  }
```

- [ ] **Step 5: Run them to see them pass, then the whole suite**

Run: `node --test test/neutral.test.mjs test/leak.test.mjs && npm test`
Expected: PASS (3 + 4 tests); suite green.

- [ ] **Step 6: Commit**

```bash
git add harness/lib/neutral.mjs harness/lib/leak.mjs harness/cli.mjs test/neutral.test.mjs test/leak.test.mjs
git commit -m "feat: neutral-name lint and leak scan"
```

---

### Task 7: Run records in the private store

**Files:**
- Create: `harness/lib/record.mjs`, `harness/store-record.mjs`
- Test: `test/record.test.mjs`

**Interfaces:**
- Consumes: `githubClient.putFile` (Task 3); the verdict shape written by `run-task.mjs` (`outcome`, `kind`, `reasons`, `issue`, `plan`, `task`, `model`, `commits`); the entry from Task 4.
- Produces:
  - `buildRecord({ verdict, entry, runId, now }): object`: an allow-list record, `v: 1`.
  - `recordPath(record): string`: `runs/<yyyy-mm>/<runId>-<index>.json`, taken from `record.ts` and `record.runner`.
  - Entry script `harness/store-record.mjs --verdict <f> --entry <f> --run-id <id>`, env `STORE_TOKEN`, `STORE_REPO`. Exits 0 silently on success; any failure prints a fixed message and exits 1.

- [ ] **Step 1: Write the failing test**

`test/record.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, recordPath } from '../harness/lib/record.mjs';

const verdict = {
  outcome: 'BLOCKED', kind: 'checks', issue: 12, plan: 'docs/p.md', task: 3, model: 'sonnet', commits: 2,
  reasons: ['x'.repeat(500), 'second', 'third', 'fourth', 'fifth', 'sixth'],
  account: 'primary', reportText: 'SECRET REPORT', report: { a: 1 }, checks: { test: { code: 1, tail: 'LOG' } },
};
const entry = { index: 1, repo: 'alice/one', tokenKind: 'classic', tokenOwner: 'alice', tokenIndex: 1 };
const now = new Date('2026-10-31T12:00:00Z');

test('a record carries only the allow-listed fields', () => {
  const r = buildRecord({ verdict, entry, runId: '777', now });
  assert.deepEqual(Object.keys(r).sort(), ['commits', 'issue', 'kind', 'model', 'outcome', 'plan', 'reasons', 'repo', 'runner', 'task', 'tokenKind', 'ts', 'v']);
  assert.equal(r.repo, 'alice/one');
  assert.equal(r.tokenKind, 'classic');
  assert.deepEqual(r.runner, { run: '777', index: 1 });
  assert.equal(r.ts, '2026-10-31T12:00:00.000Z');
  const text = JSON.stringify(r);
  assert.ok(!/SECRET REPORT|primary|LOG/.test(text), 'no account, report or log text');
});

test('reasons are trimmed to five lines of 300 characters', () => {
  const r = buildRecord({ verdict, entry, runId: '1', now });
  assert.equal(r.reasons.length, 5);
  assert.equal(r.reasons[0].length, 300);
});

test('a verdict with missing fields still builds a record', () => {
  const r = buildRecord({ verdict: { outcome: 'READY_FOR_QA' }, entry, runId: '1', now });
  assert.equal(r.outcome, 'READY_FOR_QA');
  assert.equal(r.kind, null);
  assert.deepEqual(r.reasons, []);
});

test('the path is stable for a run and index, so a retry overwrites instead of duplicating', () => {
  const r = buildRecord({ verdict, entry, runId: '777', now });
  assert.equal(recordPath(r), 'runs/2026-10/777-1.json');
  assert.equal(recordPath(buildRecord({ verdict, entry, runId: '777', now: new Date('2026-10-31T23:59:00Z') })), 'runs/2026-10/777-1.json');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/record.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

`harness/lib/record.mjs`:

```js
// One trimmed record per run, kept in a private store. An allow-list: a verdict carries
// the agent's report, the account used and check logs, none of which belong here.
export function buildRecord({ verdict, entry, runId, now = new Date() }) {
  return {
    v: 1,
    ts: now.toISOString(),
    repo: entry.repo,
    issue: verdict.issue ?? null,
    plan: verdict.plan ?? null,
    task: verdict.task ?? null,
    outcome: verdict.outcome ?? null,
    kind: verdict.kind ?? null,
    reasons: (verdict.reasons ?? []).slice(0, 5).map((r) => String(r).slice(0, 300)),
    model: verdict.model ?? null,
    commits: verdict.commits ?? 0,
    tokenKind: entry.tokenKind ?? null,
    runner: { run: String(runId), index: entry.index },
  };
}

export function recordPath(record) {
  return `runs/${record.ts.slice(0, 7)}/${record.runner.run}-${record.runner.index}.json`;
}
```

`harness/store-record.mjs`:

```js
#!/usr/bin/env node
// Writes the trimmed record of one run to the private store. Prints nothing on success and a
// fixed message on failure: this runs where logs are public.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { githubClient } from './lib/github.mjs';
import { buildRecord, recordPath } from './lib/record.mjs';

const { values } = parseArgs({ options: { verdict: { type: 'string' }, entry: { type: 'string' }, 'run-id': { type: 'string' } } });
try {
  const record = buildRecord({
    verdict: JSON.parse(readFileSync(values.verdict, 'utf8')),
    entry: JSON.parse(readFileSync(values.entry, 'utf8')),
    runId: values['run-id'],
  });
  const store = githubClient({ token: process.env.STORE_TOKEN });
  await store.putFile(process.env.STORE_REPO, recordPath(record), `${JSON.stringify(record, null, 2)}\n`, `runner: record ${record.runner.run}-${record.runner.index}`);
} catch {
  console.error('recording the run failed');
  process.exit(1);
}
```

- [ ] **Step 4: Run it to see it pass, then the whole suite**

Run: `node --test test/record.test.mjs && npm test`
Expected: PASS, 4 tests; suite green.

- [ ] **Step 5: Commit**

```bash
git add harness/lib/record.mjs harness/store-record.mjs test/record.test.mjs
git commit -m "feat: trimmed run records in the private store"
```

---

### Task 8: The clone script, the shared workflow, the caller template and the docs (hand task)

`.github/**` is a protected path, so an agent run cannot make this change. Do it by hand, test-first. The tests below read the real files and pin the review-focus items.

**Files:**
- Create: `harness/shared-clone.sh`, `.github/workflows/run-shared.yml`, `templates/runner.yml`, `docs/shared-runner.md`
- Modify: `README.md` (one short section pointing at `docs/shared-runner.md`)
- Test: `test/shared-workflow.test.mjs`

**Interfaces:**
- Consumes: everything above. `publish.sh` is reused unchanged: it reads `REPO`, `GH_TOKEN`, `VERDICT`, `RUN_URL`, `BUNDLE`, `BUNDLE_DIR`, and `TARGET_PUSH_TOKEN` for target pull requests.
- Produces: `run-shared.yml` (reusable, inputs `harness_repo`, `harness_ref`, `caller_workflow`, `projects_path`, `node_version`, `claude_code_version`; secrets `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_2`, `RUNNER_TOKENS`, `RUN_KEY`, `STORE_REPO`, `STORE_TOKEN`).

- [ ] **Step 1: Write the failing test**

`test/shared-workflow.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintNeutralNames } from '../harness/lib/neutral.mjs';

const root = join(import.meta.dirname, '..');
const wf = readFileSync(join(root, '.github/workflows/run-shared.yml'), 'utf8');
const caller = readFileSync(join(root, 'templates/runner.yml'), 'utf8');
const clone = readFileSync(join(root, 'harness/shared-clone.sh'), 'utf8');
const steps = wf.split(/\n      - /).slice(1);

test('names, groups and artifact names carry only indices', () => {
  assert.deepEqual(lintNeutralNames(wf), []);
  assert.deepEqual(lintNeutralNames(caller), []);
});

test('the caller can only be started by the schedule or by the owner, and reacts to nothing else', () => {
  assert.match(caller, /^on:\n  workflow_dispatch:\n(?:  #.*\n)*  schedule:/m);
  assert.ok(!/^\s+(issues|pull_request|pull_request_target|issue_comment|push):/m.test(caller));
  assert.match(caller, /github\.event_name == 'schedule' \|\| github\.actor == github\.repository_owner/);
});

test('the agent step never sees the tokens, the key or the store (secrets stay out of its environment)', () => {
  const agent = steps.filter((s) => /run-task\.mjs/.test(s));
  assert.equal(agent.length, 1);
  assert.ok(!/RUNNER_TOKENS|RUN_KEY|STORE_/.test(agent[0]));
  assert.match(agent[0], /CLAUDE_CODE_OAUTH_TOKEN/);
});

test('the runner repository only ever needs read access for its own token', () => {
  const perms = [...wf.matchAll(/permissions:\n((?:      +\w[\w-]*: \w+\n)+)/g)].map((m) => m[1]);
  assert.ok(perms.length >= 4);
  for (const p of perms) assert.ok(!/(contents|issues|pull-requests): write/.test(p), p);
});

test('publish decides from its own output, not from the aggregated result of the whole matrix (review focus 4)', () => {
  assert.ok(!/needs\.run\.result/.test(wf), 'needs.run.result aggregates every project');
  const publish = steps.find((s) => /Publish result/.test(s));
  assert.match(publish, /verdict\.json/);
});

test('publish.sh output and errors go to a file, never to the public log (review focus 5)', () => {
  const publish = steps.find((s) => /Publish result/.test(s));
  assert.match(publish, /publish\.sh >"\$RUNNER_TEMP\/publish\.log" 2>&1/);
});

test('the clone script keeps the token out of URLs, config and the log, and silences git errors', () => {
  assert.ok(!/set -x|set -o xtrace/.test(clone));
  assert.ok(!/x-access-token:\$\{?token/.test(clone.replace(/printf 'x-access-token:%s'/, '')), 'no token in a URL');
  assert.match(clone, /extraheader/);
  assert.match(clone, /::add-mask::/);
  assert.ok(!/git config --global|credential\.helper/.test(clone));
  const gitLines = clone.split('\n').filter((l) => /^\s*git /.test(l) || /\bgit -c /.test(l));
  for (const l of gitLines) assert.match(l, /2>\/dev\/null/, l);
});

test('the continue job needs only the right to start a workflow', () => {
  const job = wf.slice(wf.indexOf('\n  continue:'));
  assert.match(job, /actions: write/);
  assert.ok(!/contents: write|issues: write|pull-requests: write/.test(job));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/shared-workflow.test.mjs`
Expected: FAIL, `ENOENT` for the workflow file.

- [ ] **Step 3: Write `harness/shared-clone.sh`**

```bash
#!/usr/bin/env bash
# Clones the chosen project, and its target repository if it has one, with the token the
# selection resolved. The token is handed to git as a one-command header: never in a URL,
# never in git config on disk, never echoed. git's stderr is silenced because its errors name
# the repository, and this runs where logs are public.
set -Eeuo pipefail
entry="${1:?entry.json}"
dest="${2:?destination}"
: "${RUNNER_TOKENS:?}"

fail() { echo "clone failed" >&2; exit 1; }
token_for() { jq -r --arg o "$1" --argjson i "$2" '.[$o][$i] // empty' <<<"$RUNNER_TOKENS"; }

clone() { # repo token ref path withSubmodules
  local repo="$1" token="$2" ref="$3" path="$4" subs="$5"
  [ -n "$token" ] || fail
  echo "::add-mask::$token"
  local b64 header
  b64="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  echo "::add-mask::$b64"
  header="AUTHORIZATION: basic $b64"
  git -c "http.https://github.com/.extraheader=$header" clone -q --no-checkout "https://github.com/${repo}.git" "$path" 2>/dev/null || fail
  if [ -n "$ref" ]; then
    git -c "http.https://github.com/.extraheader=$header" -C "$path" checkout -q "$ref" 2>/dev/null || fail
  else
    git -c "http.https://github.com/.extraheader=$header" -C "$path" checkout -q 2>/dev/null || fail
  fi
  if [ "$subs" = "yes" ]; then
    git -c "http.https://github.com/.extraheader=$header" -C "$path" submodule update -q --init --recursive 2>/dev/null || fail
  fi
}

repo=$(jq -r .repo "$entry")
base=$(jq -r .selection.base "$entry")
clone "$repo" "$(token_for "$(jq -r .tokenOwner "$entry")" "$(jq -r .tokenIndex "$entry")")" "$base" "$dest" no

t_repo=$(jq -r '.target.repo // empty' "$entry")
if [ -n "$t_repo" ] && [ -z "$(jq -r '.target.error // empty' "$entry")" ]; then
  clone "$t_repo" \
    "$(token_for "$(jq -r .target.tokenOwner "$entry")" "$(jq -r .target.tokenIndex "$entry")")" \
    "$(jq -r '.target.ref // empty' "$entry")" \
    "$dest/$(jq -r .target.path "$entry")" yes
fi
```

- [ ] **Step 4: Write `.github/workflows/run-shared.yml`**

```yaml
name: agent-run-shared

# Runs queued tasks for many private projects from one public runner repository.
# Everything a stranger can read here (run, job, step and artifact names, logs) stays neutral:
# no repository names, issue titles or project text, only indices. Output that could carry
# project content is encrypted before it is uploaded and kept 3 days.
#   select   - claims the next task of up to N projects
#   run      - one job per chosen project; reads the project, runs the agent and the checks
#   publish  - one job per chosen project; writes to the private project with its own token
#   continue - starts the next round while work remains
# The caller must not set a workflow-level concurrency group: a slow project would hold up the
# others. The select job serialises selection itself, and a running label keeps one project
# to one task at a time.

on:
  workflow_call:
    inputs:
      harness_repo:
        type: string
        required: true
      harness_ref:
        type: string
        default: v1
      caller_workflow:
        type: string
        default: runner.yml
      projects_path:
        type: string
        default: runner/projects.json
      node_version:
        type: string
        default: '22'
      claude_code_version:
        type: string
        default: '2.1.283'
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN:
        required: true
      CLAUDE_CODE_OAUTH_TOKEN_2:
        required: false
      # JSON: { "<owner>": ["<token>", ...] }, fine-grained first, classic last.
      RUNNER_TOKENS:
        required: true
      # 16+ characters; encrypts the selection and the run output.
      RUN_KEY:
        required: true
      # The private repository that holds the project list and the run records.
      STORE_REPO:
        required: true
      STORE_TOKEN:
        required: true

jobs:
  select:
    name: select
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    concurrency:
      group: selection
      cancel-in-progress: false
    outputs:
      count: ${{ steps.select.outputs.count }}
      more: ${{ steps.select.outputs.more }}
      matrix: ${{ steps.select.outputs.matrix }}
    steps:
      - name: Checkout harness
        uses: actions/checkout@v4
        with:
          repository: ${{ inputs.harness_repo }}
          ref: ${{ inputs.harness_ref }}
          path: .harness
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node_version }}

      - name: Select
        id: select
        env:
          RUNNER_TOKENS: ${{ secrets.RUNNER_TOKENS }}
          STORE_TOKEN: ${{ secrets.STORE_TOKEN }}
          STORE_REPO: ${{ secrets.STORE_REPO }}
          PROJECTS_PATH: ${{ inputs.projects_path }}
          EVENT_NAME: ${{ github.event_name }}
        run: node .harness/harness/shared-select.mjs --store-repo "$STORE_REPO" --projects-path "$PROJECTS_PATH" --out "$RUNNER_TEMP/sel" >> "$GITHUB_OUTPUT"

      - name: Encrypt selection
        if: steps.select.outputs.count != '0'
        env:
          RUN_KEY: ${{ secrets.RUN_KEY }}
        run: node .harness/harness/cli.mjs encrypt --dir "$RUNNER_TEMP/sel" --out "$RUNNER_TEMP/selection.enc"

      - name: Upload selection
        if: steps.select.outputs.count != '0'
        uses: actions/upload-artifact@v4
        with:
          name: selection
          path: ${{ runner.temp }}/selection.enc
          retention-days: 3

  run:
    name: run (${{ matrix.index }})
    needs: select
    if: needs.select.outputs.count != '0'
    runs-on: ubuntu-latest
    timeout-minutes: 150
    permissions:
      contents: read
    strategy:
      fail-fast: false
      matrix:
        index: ${{ fromJSON(needs.select.outputs.matrix) }}
    steps:
      - name: Checkout harness
        uses: actions/checkout@v4
        with:
          repository: ${{ inputs.harness_repo }}
          ref: ${{ inputs.harness_ref }}
          path: .harness
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node_version }}

      - name: Download selection
        uses: actions/download-artifact@v4
        with:
          name: selection
          path: ${{ runner.temp }}/enc

      - name: Open selection
        id: entry
        env:
          RUN_KEY: ${{ secrets.RUN_KEY }}
          INDEX: ${{ matrix.index }}
        run: |
          node .harness/harness/cli.mjs decrypt --in "$RUNNER_TEMP/enc/selection.enc" --dir "$RUNNER_TEMP/sel"
          mkdir -p "$RUNNER_TEMP/agent"
          node .harness/harness/cli.mjs shared-entry --selections "$RUNNER_TEMP/sel/selections.json" --index "$INDEX" --out "$RUNNER_TEMP/agent" >> "$GITHUB_OUTPUT"

      # The tokens live in this step only: not on disk, not in the agent's environment.
      - name: Clone project
        if: steps.entry.outputs.skipped == 'false'
        env:
          RUNNER_TOKENS: ${{ secrets.RUNNER_TOKENS }}
        run: bash .harness/harness/shared-clone.sh "$RUNNER_TEMP/agent/entry.json" project

      - name: Install tooling
        if: steps.entry.outputs.skipped == 'false'
        env:
          CLAUDE_CODE_VERSION: ${{ inputs.claude_code_version }}
        run: |
          corepack enable
          npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

      # Config always comes from the default branch, never a stale stacked base.
      - name: Read config from the default branch
        if: steps.entry.outputs.skipped == 'false'
        env:
          DEFAULT_BRANCH: ${{ steps.entry.outputs.default }}
        run: git -C project show "origin/$DEFAULT_BRANCH:agent.config.json" > "$RUNNER_TEMP/agent/default.agent.config.json" 2>/dev/null

      - name: Note a missing target token
        if: steps.entry.outputs.skipped == 'false'
        run: |
          if [ -n "$(jq -r '.target.error // empty' "$RUNNER_TEMP/agent/entry.json")" ]; then
            echo "target configured but no usable token" > "$RUNNER_TEMP/agent/target-checkout.txt"
          fi

      # The step timeout sits inside the job's so the bundle, encrypt and upload steps below
      # still run when the agent overruns.
      - name: Run task
        if: steps.entry.outputs.skipped == 'false'
        timeout-minutes: 135
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN_2: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_2 }}
          BASE: ${{ steps.entry.outputs.base }}
        run: >-
          node .harness/harness/run-task.mjs
          --project project
          --issue "$RUNNER_TEMP/agent/issue.json"
          --out "$RUNNER_TEMP/agent"
          --base-branch "$BASE"
          --config "$RUNNER_TEMP/agent/default.agent.config.json"
          --selection "$RUNNER_TEMP/agent/selection.json" >/dev/null 2>&1

      - name: Bundle the agent branch
        if: always() && steps.entry.outputs.skipped == 'false'
        env:
          ISSUE: ${{ steps.entry.outputs.issue }}
          BASE: ${{ steps.entry.outputs.base }}
        run: |
          branch="agent/issue-$ISSUE"
          rm -f "$RUNNER_TEMP/agent/branch.bundle"
          if git -C project rev-parse -q --verify "refs/heads/$branch" >/dev/null 2>&1 \
            && [ "$(git -C project rev-list --count "origin/$BASE..refs/heads/$branch" 2>/dev/null)" -gt 0 ]; then
            git -C project bundle create "$RUNNER_TEMP/agent/branch.bundle" "refs/heads/$branch" >/dev/null 2>&1
          fi

      - name: Encrypt run output
        if: always()
        env:
          RUN_KEY: ${{ secrets.RUN_KEY }}
        run: |
          find "$RUNNER_TEMP/agent" -type l -delete
          node .harness/harness/cli.mjs encrypt --dir "$RUNNER_TEMP/agent" --out "$RUNNER_TEMP/run-output.enc"

      - name: Upload run output
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: output-${{ matrix.index }}
          path: ${{ runner.temp }}/run-output.enc
          if-no-files-found: warn
          retention-days: 3

  publish:
    name: publish (${{ matrix.index }})
    needs: [select, run]
    if: always() && needs.select.outputs.count != '0'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
    strategy:
      fail-fast: false
      matrix:
        index: ${{ fromJSON(needs.select.outputs.matrix) }}
    steps:
      - name: Checkout harness
        uses: actions/checkout@v4
        with:
          repository: ${{ inputs.harness_repo }}
          ref: ${{ inputs.harness_ref }}
          path: .harness
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node_version }}

      - name: Download selection
        uses: actions/download-artifact@v4
        with:
          name: selection
          path: ${{ runner.temp }}/enc

      - name: Download run output
        continue-on-error: true
        uses: actions/download-artifact@v4
        with:
          name: output-${{ matrix.index }}
          path: ${{ runner.temp }}/enc-out

      - name: Open selection and output
        env:
          RUN_KEY: ${{ secrets.RUN_KEY }}
          INDEX: ${{ matrix.index }}
        run: |
          node .harness/harness/cli.mjs decrypt --in "$RUNNER_TEMP/enc/selection.enc" --dir "$RUNNER_TEMP/sel"
          mkdir -p "$RUNNER_TEMP/agent"
          node .harness/harness/cli.mjs shared-entry --selections "$RUNNER_TEMP/sel/selections.json" --index "$INDEX" --out "$RUNNER_TEMP/selection-files" >/dev/null
          if [ -f "$RUNNER_TEMP/enc-out/run-output.enc" ]; then
            node .harness/harness/cli.mjs decrypt --in "$RUNNER_TEMP/enc-out/run-output.enc" --dir "$RUNNER_TEMP/agent" || echo "run output could not be opened"
          fi

      # A matrix reports one combined result, so the verdict comes from this project's own
      # output: present means the run finished, absent means it crashed or timed out.
      - name: Publish result
        env:
          RUNNER_TOKENS: ${{ secrets.RUNNER_TOKENS }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set +x
          entry="$RUNNER_TEMP/selection-files/entry.json"
          sel="$RUNNER_TEMP/selection-files/selection.json"
          token_for() { jq -r --arg o "$1" --argjson i "$2" '.[$o][$i] // empty' <<<"$RUNNER_TOKENS"; }
          GH_TOKEN="$(token_for "$(jq -r .tokenOwner "$entry")" "$(jq -r .tokenIndex "$entry")")"
          echo "::add-mask::$GH_TOKEN"
          if [ -n "$(jq -r '.target.repo // empty' "$entry")" ] && [ -z "$(jq -r '.target.error // empty' "$entry")" ]; then
            TARGET_PUSH_TOKEN="$(token_for "$(jq -r .target.tokenOwner "$entry")" "$(jq -r .target.tokenIndex "$entry")")"
            echo "::add-mask::$TARGET_PUSH_TOKEN"
            export TARGET_PUSH_TOKEN
          fi
          export GH_TOKEN REPO="$(jq -r .repo "$entry")" RUN_URL
          export VERDICT="$RUNNER_TEMP/publish-verdict.json" BUNDLE="$RUNNER_TEMP/agent/branch.bundle" BUNDLE_DIR="$RUNNER_TEMP/agent"
          if [ "$(jq -r '.selection.skip // empty' "$entry")" != "" ]; then
            node .harness/harness/cli.mjs skip-verdict --selection "$sel" > "$VERDICT"
          elif [ -f "$RUNNER_TEMP/agent/verdict.json" ]; then
            cp "$RUNNER_TEMP/agent/verdict.json" "$VERDICT"
          else
            node .harness/harness/cli.mjs fallback-verdict --selection "$sel" > "$VERDICT"
          fi
          # publish.sh ends with a line that names the pull request, and gh and git errors name
          # the repository: keep every byte of it out of the public log.
          if bash .harness/harness/publish.sh >"$RUNNER_TEMP/publish.log" 2>&1; then
            echo "published"
          else
            echo "publish failed"
            exit 1
          fi

      - name: Record run
        if: always()
        env:
          STORE_TOKEN: ${{ secrets.STORE_TOKEN }}
          STORE_REPO: ${{ secrets.STORE_REPO }}
          RUN_ID: ${{ github.run_id }}
        run: |
          [ -f "$RUNNER_TEMP/publish-verdict.json" ] || exit 0
          node .harness/harness/store-record.mjs --verdict "$RUNNER_TEMP/publish-verdict.json" --entry "$RUNNER_TEMP/selection-files/entry.json" --run-id "$RUN_ID" || true

  continue:
    name: continue
    needs: [select, publish]
    if: always() && needs.select.outputs.more == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: write
      contents: read
    steps:
      - name: Start the next round
        env:
          GH_TOKEN: ${{ github.token }}
          CALLER: ${{ inputs.caller_workflow }}
          REF: ${{ github.event.repository.default_branch }}
        run: gh workflow run "$CALLER" --repo "$GITHUB_REPOSITORY" --ref "$REF"
```

Notes for whoever writes this by hand:
- `run-task.mjs` output goes to `/dev/null` in this workflow because its only console line is the verdict summary (`verdict.reasons` can carry project text). Its full result is in `verdict.json`.
- The verdict's `skip` case never runs the agent: `run` steps are skipped and the encrypted output holds only `entry.json`, `selection.json` and `issue.json`.
- `needs.select.outputs.matrix` is an array of indices only (`[0,1]`).
- If a "no usable token" project must be visible to you, read the count the select job prints to the private record, not the log.

- [ ] **Step 5: Write `templates/runner.yml`**

```yaml
name: runner

# The public runner repository's only workflow. It starts on the schedule or when the owner
# runs it by hand, and on nothing else: no issues, pull requests or pushes. Replace OWNER and
# keep harness_ref equal to the @ref in `uses:` below.
run-name: run

on:
  workflow_dispatch:
  # Hourly at :30, 16:30-02:30 UTC (move it to your night). Public repositories get free
  # minutes, but a scheduled run still takes a runner for a few seconds.
  schedule:
    - cron: '30 16-23,0-2 * * *'

permissions:
  contents: read
  actions: write

jobs:
  runner:
    if: github.event_name == 'schedule' || github.actor == github.repository_owner
    uses: OWNER/agent-harness/.github/workflows/run-shared.yml@v1
    with:
      harness_repo: OWNER/agent-harness
      harness_ref: v1
      caller_workflow: runner.yml
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      CLAUDE_CODE_OAUTH_TOKEN_2: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_2 }}
      RUNNER_TOKENS: ${{ secrets.RUNNER_TOKENS }}
      RUN_KEY: ${{ secrets.RUN_KEY }}
      STORE_REPO: ${{ secrets.STORE_REPO }}
      STORE_TOKEN: ${{ secrets.STORE_TOKEN }}
```

- [ ] **Step 6: Write `docs/shared-runner.md` and the README section**

`docs/shared-runner.md` (generic; no real names):

```markdown
# Shared runner

One public repository runs the harness for any number of private projects. Public repositories get free hosted-runner minutes. Nothing about a project is readable in public except that a run happened, when it started and how long it took.

## What is public and what is not

| Public | Hidden |
|---|---|
| That a run happened, its time and duration | Repository names, task titles, plans, code, diffs, test output, agent output |
| Neutral names: `run (0)`, `publish (1)` | Issues, PRs and comments (they live in the private project) |
| Encrypted run output, kept 3 days | The project list, the run records, the key |

## Setup

1. Create a public repository for the runner with a neutral name. It holds only `.github/workflows/runner.yml`, copied from `templates/runner.yml`.
2. Create a private repository for the store. Put the project list at `runner/projects.json`:
   ```json
   { "projects": [ { "repo": "owner/project-a" }, { "repo": "org/project-b", "tokenOwner": "owner", "targetTokenOwner": "org" } ], "maxParallel": 3 }
   ```
3. Set these secrets on the runner repository: `CLAUDE_CODE_OAUTH_TOKEN` (and `_2`), `RUNNER_TOKENS` (`{"owner":["<fine-grained>","<classic>"],"org":["<token>"]}`), `RUN_KEY` (16+ random characters), `STORE_REPO` (`owner/store`), `STORE_TOKEN` (reads the project list, writes run records).
4. In each project: keep `agent.config.json` and the plans as today, remove `.github/workflows/agent.yml` and `agent-close-merged.yml` when you cut over. Label an issue `agent` as before.
5. Start a round by hand with `gh workflow run runner.yml --repo <owner>/<runner>`, or wait for the schedule.

## How tokens are chosen

Each owner has an ordered list, fine-grained first and classic last. For every project the runner tries them in order and uses the first that can read the repository and, for the steps that write, push to it.

## Opening an encrypted run output

Download the artifact `output-<n>` from the run page, then:

    RUN_KEY=<key> node harness/cli.mjs decrypt --in run-output.enc --dir out

## Checking for leaks

Keep a blocklist (one term per line) in the private store, never in a public repository, and run:

    node harness/cli.mjs leak-scan --blocklist blocklist.txt --root <public checkout> --file run.log

It prints `path:line` for each hit and never prints the term.
```

Add to `README.md`, after the "Target repositories" section:

```markdown
## Shared runner

To run the harness for many private projects from one public repository, at no hosted-runner cost, see `docs/shared-runner.md`.
```

- [ ] **Step 7: Run the test to see it pass, then the whole suite**

Run: `node --test test/shared-workflow.test.mjs && npm test`
Expected: PASS, 8 tests; suite green. If the "clone script" test fails on a line, fix that line in `shared-clone.sh`, not the test.

- [ ] **Step 8: Commit**

```bash
git add harness/shared-clone.sh .github/workflows/run-shared.yml templates/runner.yml docs/shared-runner.md README.md test/shared-workflow.test.mjs
git commit -m "feat: shared runner workflow, caller template and docs"
```

---

### Task 9: Dry run and rollout (hand)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-31-shared-runner-design.md` (record the dry run)

- [ ] **Step 1: Tag a beta.** Move or create a harness tag for the runner (for example `v1.4-beta`) on the merged commit. Do not move `v1`.
- [ ] **Step 2: Scratch dry run.** Create a scratch public runner repository and a scratch private project with `agent.config.json`, a trivial plan and one `agent`-labelled task issue. Put a project list in a scratch private store. Set the secrets (a test `RUN_KEY`, real Claude token, tokens limited to the scratch repositories). Run `gh workflow run runner.yml`.
- [ ] **Step 3: Read it as a stranger.** Open the run page signed out and the artifact list. Expected: `select`, `run (0)`, `publish (0)`, an encrypted `output-0` and `selection`, no repository name, issue title or plan text anywhere. Download the run log with `gh run view --log` and run `leak-scan` against it with a blocklist holding the scratch names. Expected: no hits.
- [ ] **Step 4: Check the private side.** The task issue has its READY or BLOCKED comment, the PR is in the private repo, and the store has `runs/<yyyy-mm>/<run>-0.json` with no report text and no account.
- [ ] **Step 5: Check the failure paths.** Remove the task's token access and run again (expect a skipped project and no names in the log); kill a run mid-way and wait past 3 hours (expect the task released as blocked); label two tasks in two projects and confirm they run side by side.
- [ ] **Step 6: Cut projects over, least sensitive first.** For each project: add it to the project list, confirm one task end to end, then remove its `agent.yml` and `agent-close-merged.yml`. Move the most sensitive project last, after `leak-scan` has been clean on every earlier run.
- [ ] **Step 7: Record the result in the spec and commit**

```bash
git add docs/superpowers/specs/2026-10-31-shared-runner-design.md
git commit -m "docs: record shared runner dry run"
```

---

## Self-review

- **Spec coverage:** goal and decisions (Tasks 1-9); poll-based select across projects with a manual start (Tasks 3, 4, 8); ordered tokens, fine-grained first (Task 2, 4); encryption with 3-day retention (Tasks 5, 8); project list in a private place (Tasks 4, 8, docs); parallel cap and one task per project (Task 3); neutral names (Tasks 6, 8); leak tests with a private blocklist (Task 6); close-merged moved into the runner (Tasks 3, 4); per-owner token map and owner gate (Tasks 2, 8); run records in the private store (Task 7); targets for projects that need a second repository (Tasks 4, 8); rollout (Task 9).
- **Spec amendments this plan makes** (apply to the spec when approving): encryption is `node:crypto` AES-256-GCM, not `gpg` (closes that risk item); a stale `agent:running` label older than 3 hours is released as blocked; waiting tasks are only resumed by the scheduled run; the select job holds a short serialising lock; the store needs a token and a repository name as secrets; the next round starts when the slowest project of the current round ends (the schedule and the manual start cover the gap).
- **Placeholder scan:** none; every code step has the code.
- **Type consistency:** `entry` fields (`index`, `repo`, `tokenOwner`, `tokenIndex`, `tokenKind`, `defaultBranch`, `selection`, `target`) are written in Task 4 and read in Tasks 5, 7 and 8; `target` keys (`repo`, `path`, `ref`, `tokenOwner`, `tokenIndex`, `tokenKind`, `error`) match between Task 4's test and `shared-clone.sh`; `githubClient` method names match between Tasks 3, 4 and 7.
- **Known limits:** a project's `agent.config.json` is read from its default branch at select time; a project with no usable token is skipped silently (counted, not named); the `permissions` probe depends on the Task 0 finding.


---

## Part 2: isolating the run job (added after the whole-branch review, finding C1)

Design: spec section 6.1. The matrix workflow of Task 8 is replaced by three slot calls. Tasks 9-14 below are built test-first; the exact code is in the commits.

- **Task 9: hybrid sealing.** `harness/lib/crypt.mjs`: `generateKeypair()`, `sealDir(dir, outFile, publicKey, { aad })`, `openSealed(file, dir, privateKey, { aad })` (X25519, HKDF-SHA256, AES-256-GCM, tag checked before unpacking), `tagFor(secret, runId, label)` (HMAC-SHA256, 24 hex), safe unpacking (names checked, no links or special files). CLI: `keygen`, `seal`, `open`, `tag`.
- **Task 10: verdict guard.** `harness/lib/verdict-guard.mjs` and CLI `guard-verdict`: the trusted entry is authoritative for `issue`, `branch`, `baseBranch`, `task`; targets are limited to the allow-list, branch recomputed from the template, bundle names plain, `baseSha` 40 hex; anything else becomes a BLOCKED verdict.
- **Task 11: allow-lists in the project list.** `projects.mjs`: `target: { repo, tokenOwner, allow: [repos] }` replaces `targetTokenOwner`; `maxParallel` 1 to 3. `shared-run.mjs`: the config's target must equal the listed one, otherwise the entry carries an error.
- **Task 12: clone and bundle.** `harness/shared-clone.sh`: protocol hardening, `.gitmodules` parsed before git acts and every submodule at every depth checked against the allow-list; the entry for the run is written into the checkout directory.
- **Task 13: slot workflows.** `.github/workflows/run-slot.yml` (clone, run, publish), `run-shared.yml` (select, three slot calls, continue), `harness/wait-artifact.sh`; lints that pin which secrets each job may reference, permissions, neutral names and env values.
- **Task 14: docs, a second independent security review, dry run.** The dry run on scratch repositories remains required before any real project is added.
