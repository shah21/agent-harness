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

test('a project with a recent running task is left alone, and does not ask for another round', async () => {
  const table = {
    'a/one': data([issue(1, 1, ['agent:running'], { updatedAt: iso(1000) }), issue(2, 2, ['agent'])]),
    'a/two': data([issue(3, 1, ['agent:ready'])]),
  };
  const r = await selectAcrossProjects({ projects: ['a/one', 'a/two'].map(project), maxParallel: 3, load: loadFrom(table), now: NOW });
  assert.deepEqual(r.chosen, []);
  assert.equal(r.more, false, 'rerunning at once would only find the project busy again');
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

test('a paused task keeps its place: a later task never jumps ahead of it', async () => {
  const table = { 'a/one': data([issue(1, 1, ['agent:waiting']), issue(2, 2, ['agent'])]) };
  const common = { projects: [project('a/one')], maxParallel: 3, load: loadFrom(table), now: NOW };
  const off = await selectAcrossProjects({ ...common, resume: false });
  assert.deepEqual(off.chosen, []);
  assert.equal(off.more, false);
  const on = await selectAcrossProjects({ ...common, resume: true });
  assert.equal(on.chosen[0].selection.issue.number, 1);
});

test('a stale task that was also re-labelled for a retry is released, not run in the same round', async () => {
  const both = issue(1, 1, ['agent:running', 'agent'], { updatedAt: iso(STALE_MS + 1) });
  const table = { 'a/one': data([both]) };
  const r = await selectAcrossProjects({ projects: [project('a/one')], maxParallel: 3, load: loadFrom(table), now: NOW });
  assert.deepEqual(r.released.map((x) => x.issue), [1]);
  assert.deepEqual(r.chosen, []);
});

test('one project failing to load does not stop the others, and nothing names it', async () => {
  const table = { 'a/two': data([issue(3, 1, ['agent'])]) };
  const load = async (p) => {
    if (p.repo === 'zzsecret/broken') throw new Error('github: GET failed (500)');
    return table[p.repo];
  };
  const r = await selectAcrossProjects({ projects: ['zzsecret/broken', 'a/two'].map(project), maxParallel: 3, load, now: NOW });
  assert.deepEqual(r.chosen.map((c) => c.project.repo), ['a/two']);
  assert.equal(r.failed, 1);
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
