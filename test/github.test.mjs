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
    reply: (url) => ({ body: /[?&]page=1$/.test(url) ?[...page1.slice(0, 99), issue(500, [], { pull_request: {} })] : [issue(101, ['agent'])] }),
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
  const puts = [];
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

test('prMerged reads the merged flag of one pull request', async () => {
  const { fetchImpl } = makeFetch([
    { method: 'GET', match: /\/repos\/a\/b\/pulls\/7$/, reply: { body: { merged: true } } },
    { method: 'GET', match: /\/repos\/a\/b\/pulls\/8$/, reply: { body: { merged: false } } },
  ]);
  const c = githubClient({ token: 't', fetchImpl });
  assert.equal(await c.prMerged('a/b', 7), true);
  assert.equal(await c.prMerged('a/b', 8), false);
});

test('comments reads the newest comments, not the oldest: the last two pages of a long thread', async () => {
  const mk = (page) => Array.from({ length: 100 }, (_, i) => ({ body: `p${page}-${i}` }));
  const { fetchImpl, calls } = makeFetch([{
    method: 'GET',
    match: /\/repos\/a\/b\/issues\/7\/comments/,
    reply: (url) => {
      const page = Number(/[?&]page=(\d+)/.exec(url)[1]);
      return {
        headers: { link: '<https://api.github.com/x?per_page=100&page=2>; rel="next", <https://api.github.com/x?per_page=100&page=3>; rel="last"' },
        body: page === 3 ? [{ body: 'ready-last' }] : mk(page),
      };
    },
  }]);
  const out = await githubClient({ token: 't', fetchImpl }).comments('a/b', 7);
  assert.equal(out.at(-1).body, 'ready-last');
  assert.ok(out.some((c) => c.body === 'p2-0'), 'the page before the last is included');
  assert.ok(!out.some((c) => c.body.startsWith('p1-')), 'the oldest page is not read');
  assert.ok(calls.length <= 3);
});

test('comments: last page 2 reuses page 1, and a reply with no Link header is one page', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ body: `a${i}` }));
  const two = makeFetch([{ method: 'GET', match: /\/issues\/1\/comments/, reply: (url) => ({
    headers: { link: '<https://api.github.com/x?per_page=100&page=2>; rel="last"' },
    body: /[?&]page=2$/.test(url) ? [{ body: 'b0' }] : page1,
  }) }]);
  const a = await githubClient({ token: 't', fetchImpl: two.fetchImpl }).comments('a/b', 1);
  assert.equal(a.length, 101);
  assert.equal(two.calls.length, 2);
  const one = makeFetch([{ method: 'GET', match: /\/issues\/1\/comments/, reply: { body: page1 } }]);
  const b = await githubClient({ token: 't', fetchImpl: one.fetchImpl }).comments('a/b', 1);
  assert.equal(b.length, 100);
  assert.equal(one.calls.length, 1);
});
