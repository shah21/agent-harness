import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSharedSelect } from '../harness/lib/shared-run.mjs';
import { makeFetch } from './helpers/fake-fetch.mjs';
import { targetsMarker } from '../harness/lib/target.mjs';

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
  { method: 'PATCH', match: new RegExp(`/repos/${repo}/issues/\\d+$`), reply: { body: {} } },
];
const gi = (number, task, labels = ['agent'], updated = '2026-10-31T11:59:00Z') => ({ number, title: `T${task}`, body: `plan: docs/p.md\ntask: ${task}`, labels: labels.map((name) => ({ name })), updated_at: updated });
const out = () => mkdtempSync(join(tmpdir(), 'sel-'));
const tokens = JSON.stringify({ alice: ['github_pat_no', 'ghp_ok'] });

test('claims one task per project, resolves tokens and writes entries with indices', async () => {
  const { fetchImpl, calls } = makeFetch([...repoHandlers('alice/one', { issues: [gi(1, 1), gi(2, 2)] }), ...repoHandlers('alice/two', { issues: [gi(9, 1)] })]);
  const dir = out();
  const r = await runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'alice/one' }, { repo: 'alice/two' }] }), tokensText: tokens, outDir: dir, fetchImpl, now: NOW });
  assert.deepEqual(r, { count: 2, more: true, skippedNoToken: 0, failed: 0 });
  const entries = JSON.parse(readFileSync(join(dir, 'selections.json'), 'utf8'));
  assert.deepEqual(entries.map((e) => [e.index, e.repo, e.tokenIndex, e.tokenKind, e.selection.issue.number]), [[0, 'alice/one', 1, 'classic', 1], [1, 'alice/two', 1, 'classic', 9]]);
  const claims = calls.filter((c) => c.method === 'POST' && /labels$/.test(c.url));
  assert.deepEqual(claims.map((c) => c.body.labels), [['agent:running'], ['agent:running']]);
});

test('a project no token can reach is skipped and counted, with nothing printed (review focus 1)', async () => {
  const printed = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a) => printed.push(a.join(' '));
  console.error = (...a) => printed.push(a.join(' '));
  try {
    const { fetchImpl } = makeFetch([...repoHandlers('alice/one', { issues: [gi(1, 1)], push: false })]);
    const r = await runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'alice/one' }] }), tokensText: tokens, outDir: out(), fetchImpl, now: NOW });
    assert.deepEqual(r, { count: 0, more: false, skippedNoToken: 1, failed: 0 });
  } finally {
    console.log = orig;
    console.error = origErr;
  }
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

test('a crashed run is released and its stacked task waits behind it', async () => {
  const stale = gi(1, 1, ['agent:running'], '2026-10-31T01:00:00Z');
  const { fetchImpl, calls } = makeFetch(repoHandlers('alice/one', { issues: [stale, gi(2, 2)] }));
  const dir = out();
  const r = await runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'alice/one' }] }), tokensText: tokens, outDir: dir, fetchImpl, now: NOW, resume: false });
  assert.equal(r.count, 1);
  const [e] = JSON.parse(readFileSync(join(dir, 'selections.json'), 'utf8'));
  assert.equal(e.selection.issue.number, 2);
  assert.match(e.selection.skip, /blocked/);
  const blocked = calls.find((c) => c.method === 'POST' && c.body?.labels?.includes('agent:blocked'));
  assert.ok(blocked, 'the stale task was labelled blocked');
  assert.ok(calls.some((c) => c.method === 'DELETE' && /labels\/agent$/.test(c.url) && /issues\/1\//.test(c.url)), 'and no longer queued');
});

test('bad input is rejected before any request is made', async () => {
  const { fetchImpl, calls } = makeFetch([]);
  await assert.rejects(() => runSharedSelect({ projectsText: 'nope', tokensText: tokens, outDir: out(), fetchImpl, now: NOW }), /projects/);
  await assert.rejects(() => runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'a/b' }] }), tokensText: 'nope', outDir: out(), fetchImpl, now: NOW }), /tokens/);
  assert.equal(calls.length, 0);
});

test('a project whose requests fail is counted, the others still run, and nothing is printed', async () => {
  const printed = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a) => printed.push(a.join(' '));
  console.error = (...a) => printed.push(a.join(' '));
  try {
    const { fetchImpl } = makeFetch([
      { method: 'GET', match: /\/repos\/zzsecret\/broken$/, reply: (url, init) => ({ body: { default_branch: 'main', permissions: { pull: true, push: init.headers.authorization === 'Bearer ghp_ok' } } }) },
      { method: 'GET', match: /\/repos\/zzsecret\/broken\/issues/, reply: { status: 410, body: {} } },
      ...repoHandlers('alice/two', { issues: [gi(9, 1)] }),
    ]);
    const dir = out();
    const r = await runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'zzsecret/broken', tokenOwner: 'alice' }, { repo: 'alice/two' }] }), tokensText: tokens, outDir: dir, fetchImpl, now: NOW });
    assert.deepEqual(r, { count: 1, more: false, skippedNoToken: 0, failed: 1 });
    assert.equal(JSON.parse(readFileSync(join(dir, 'selections.json'), 'utf8'))[0].repo, 'alice/two');
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  assert.deepEqual(printed, []);
});

test('an issue whose target pull request merged is closed (the runner replaces the per-repo workflow)', async () => {
  const readyBody = `\u2705 **READY_FOR_QA**\n\n${targetsMarker([{ repo: 'org/code', number: 7, branch: 'agent/issue-5', base: 'main', role: 'super' }])}`;
  const { fetchImpl, calls } = makeFetch([
    ...repoHandlers('alice/one', { issues: [gi(5, 1, ['agent:ready'])] }),
    { method: 'GET', match: /\/repos\/alice\/one\/issues\/5\/comments/, reply: { body: [{ body: readyBody }] } },
    { method: 'GET', match: /\/repos\/org\/code$/, reply: { body: { permissions: { pull: true, push: false } } } },
    { method: 'GET', match: /\/repos\/org\/code\/pulls\/7$/, reply: { body: { merged: true } } },
  ]);
  await runSharedSelect({ projectsText: JSON.stringify({ projects: [{ repo: 'alice/one', targetTokenOwner: 'org' }] }), tokensText: JSON.stringify({ alice: ['ghp_ok'], org: ['ghp_org'] }), outDir: out(), fetchImpl, now: NOW });
  const closed = calls.find((c) => c.method === 'PATCH' && /issues\/5$/.test(c.url));
  assert.deepEqual(closed.body, { state: 'closed', state_reason: 'completed' });
});
