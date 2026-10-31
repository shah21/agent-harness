import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardVerdict } from '../harness/lib/verdict-guard.mjs';

const SHA = 'a'.repeat(40);
const entry = (extra = {}) => ({
  index: 0,
  repo: 'alice/one',
  taskTitle: 'feat: add the thing',
  selection: { issue: { number: 12, title: 'T' }, plan: 'docs/p.md', task: 3, base: 'main', skip: null },
  target: null,
  ...extra,
});
const withTarget = (over = {}) => entry({
  selection: { issue: { number: 12, title: 'T' }, plan: 'docs/p.md', task: 3, base: 'main', skip: null, targetBase: 'release/1' },
  target: { repo: 'org/code', path: 'target', ref: '', tokenOwner: 'org', tokenIndex: 0, tokenKind: 'classic', allow: ['org/sub-a'], branchTemplate: '{type}/{slug}', ...over },
});
const verdict = (extra = {}) => ({
  outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings: [], issue: 12, issueTitle: 'T', plan: 'docs/p.md', task: 3,
  taskTitle: 'feat: add the thing', baseBranch: 'main', branch: 'agent/issue-12', commits: 2, checks: {}, report: null, reportText: 'text', ...extra,
});
const target = (extra = {}) => ({
  repo: 'org/code', role: 'super', commits: 1, branch: 'feat/add-the-thing', base: 'release/1', baseSha: SHA,
  bundle: 'org__code.bundle', prTitle: 'Task 3: feat: add the thing', prBody: 'body', ...extra,
});
const isBundle = () => true;
const guard = (v, e = entry(), over = {}) => guardVerdict({ verdict: v, entry: e, bundleDir: '/b', isBundle, ...over });

test('a genuine verdict passes through unchanged', () => {
  const v = verdict();
  const r = guard(v);
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdict, v);
});

test('a genuine verdict with targets passes, and a target that changed nothing is dropped', () => {
  const v = verdict({ targets: [target(), target({ repo: 'org/sub-a', role: 'sub', bundle: 'org__sub-a.bundle' }), target({ repo: 'org/anything', commits: 0 })] });
  const r = guard(v, withTarget());
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdict.targets.map((t) => t.repo), ['org/code', 'org/sub-a']);
});

test('the outcome must be one of the three the publisher understands', () => {
  for (const outcome of ['MERGED', '', null, undefined, 7]) assert.equal(guard(verdict({ outcome })).ok, false);
  for (const v of [null, [], 'x', 3]) assert.equal(guard(v).ok, false);
});

test('the issue, branch, base and task come from the trusted selection: a verdict that disagrees is rejected', () => {
  for (const over of [
    { issue: 13 }, { branch: 'main' }, { branch: 'agent/issue-13' }, { branch: 'agent/issue-12/../x' },
    { baseBranch: 'develop' }, { task: 4 }, { plan: 'docs/other.md' },
  ]) {
    const r = guard(verdict(over));
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.reason, 'the run output did not match its task');
  }
});

test('a target in a repository the owner did not allow is rejected (a classic token reaches every repo)', () => {
  for (const repo of ['victim/other', 'org/code-evil', 'org/sub-b', 'ORG/code']) {
    const r = guard(verdict({ targets: [target({ repo })] }), withTarget());
    assert.equal(r.ok, false, repo);
    assert.equal(r.reason, 'the run output named a repository that is not allowed');
  }
  assert.equal(guard(verdict({ targets: [target()] }), entry()).ok, false, 'no target configured, none allowed');
  assert.equal(guard(verdict({ targets: [target()] }), withTarget({ error: 'no usable token' })).ok, false);
});

test('a target branch must be the one the trusted template gives, with a safe prefix', () => {
  for (const branch of ['main', 'master', 'fix/something-else', 'feat/add-the-thing/../x', 'feat/add-the-thing ']) {
    assert.equal(guard(verdict({ targets: [target({ branch })] }), withTarget()).ok, false, branch);
  }
  const noVars = withTarget({ branchTemplate: 'main' });
  assert.equal(guard(verdict({ targets: [target({ branch: 'main' })] }), noVars).reason, 'the run output named an unsafe branch');
  const custom = withTarget({ branchTemplate: 'tj/{slug}', branchPrefixes: ['tj/'] });
  assert.equal(guard(verdict({ targets: [target({ branch: 'tj/add-the-thing' })] }), custom).ok, true);
  const agent = withTarget({ branchTemplate: 'agent/issue-{issue}' });
  assert.equal(guard(verdict({ targets: [target({ branch: 'agent/issue-12' })] }), agent).ok, true);
});

test('a target base must be one the trusted selection knows', () => {
  assert.equal(guard(verdict({ targets: [target({ base: 'main' })] }), withTarget()).ok, false);
  assert.equal(guard(verdict({ targets: [target({ base: null })] }), withTarget()).ok, true, 'null means the default branch');
  assert.equal(guard(verdict({ targets: [target({ base: 'release/1' })] }), withTarget()).ok, true);
});

test('bundle names must be plain files that exist, and the base sha must be a full sha', () => {
  for (const bundle of ['../../etc/passwd', '/etc/passwd', 'a/b.bundle', 'x.sh', '.bundle', '']) {
    const r = guard(verdict({ targets: [target({ bundle })] }), withTarget());
    assert.equal(r.ok, false, bundle);
    assert.equal(r.reason, 'the run output named an unsafe bundle');
  }
  assert.equal(guard(verdict({ targets: [target()] }), withTarget(), { isBundle: () => false }).ok, false);
  for (const baseSha of ['main', 'abc', 'a'.repeat(39), `${'a'.repeat(40)}\n--force`, '--upload-pack=x']) {
    assert.equal(guard(verdict({ targets: [target({ baseSha })] }), withTarget()).ok, false, baseSha);
  }
});

test('only one super repository, and the other fields must have the right types', () => {
  assert.equal(guard(verdict({ targets: [target(), target()] }), withTarget()).ok, false);
  assert.equal(guard(verdict({ targets: [target({ role: 'root' })] }), withTarget()).ok, false);
  assert.equal(guard(verdict({ targets: 'x' }), withTarget()).ok, false);
  assert.equal(guard(verdict({ targets: [null] }), withTarget()).ok, false);
  assert.equal(guard(verdict({ targets: [target({ prBody: 5 })] }), withTarget()).ok, false);
  assert.equal(guard(verdict({ targets: [target({ commits: -1 })] }), withTarget()).ok, true, 'non-positive commits are dropped, not used');
});

test('rejections carry fixed text only, never anything from the verdict', () => {
  const r = guard(verdict({ targets: [target({ repo: 'zzsecret/evil', branch: 'zzsecret-branch', bundle: '../zzsecret' })] }), withTarget());
  assert.equal(r.ok, false);
  assert.ok(!/zzsecret/.test(r.reason));
});

test('the CLI prints the verdict when it passes and a BLOCKED one when it does not', () => {
  const cli = join(import.meta.dirname, '..', 'harness', 'cli.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  writeFileSync(join(dir, 'entry.json'), JSON.stringify(entry()));
  writeFileSync(join(dir, 'good.json'), JSON.stringify(verdict()));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify(verdict({ branch: 'main', reasons: ['zzsecret'] })));
  const run = (f) => spawnSync('node', [cli, 'guard-verdict', '--verdict', join(dir, f), '--entry', join(dir, 'entry.json'), '--bundle-dir', dir], { encoding: 'utf8' });
  const good = run('good.json');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).outcome, 'READY_FOR_QA');
  const bad = run('bad.json');
  assert.equal(bad.status, 0, bad.stderr);
  const blocked = JSON.parse(bad.stdout);
  assert.equal(blocked.outcome, 'BLOCKED');
  assert.equal(blocked.branch, 'agent/issue-12');
  assert.equal(blocked.kind, 'harness');
  assert.ok(!/zzsecret|"main"/.test(bad.stdout.replace('"baseBranch": "main"', '')), 'nothing from the rejected verdict survives');
  assert.equal(spawnSync('node', [cli, 'guard-verdict', '--verdict', join(dir, 'nope.json'), '--entry', join(dir, 'entry.json'), '--bundle-dir', dir], { encoding: 'utf8' }).status, 1);
});

test('review data is typed: it is rendered into file names by the publisher (review M3)', () => {
  const ok = verdict({ review: { rounds: [{ n: 1 }, { n: 2 }], open: [] } });
  assert.equal(guard(ok).ok, true);
  for (const review of ['x', 5, [], { rounds: 'x' }, { rounds: [{ n: '1' }] }, { rounds: [{ n: 0 }] }, { rounds: [{ n: 11 }] },
    { rounds: [{ n: 1.5 }] }, { rounds: [{ n: '/../../../x' }] }, { rounds: [null] }, { rounds: Array.from({ length: 11 }, (_, i) => ({ n: i + 1 })) }, { rounds: [], open: 'x' }]) {
    assert.equal(guard(verdict({ review })).ok, false, JSON.stringify(review));
  }
  assert.equal(guard(verdict({ review: null })).ok, true);
});

test('the task, plan and title that reach the pull request come from the trusted entry, not the run (review L2)', () => {
  const r = guard(verdict({ task: null, plan: null, taskTitle: 'x\n--injected' }), entry());
  assert.equal(r.ok, true);
  assert.equal(r.verdict.task, 3);
  assert.equal(r.verdict.plan, 'docs/p.md');
  assert.equal(r.verdict.taskTitle, 'feat: add the thing');
  const noTitle = guard(verdict({ taskTitle: 'from the run' }), entry({ taskTitle: null }));
  assert.equal(noTitle.verdict.taskTitle, 'from the run', 'without a trusted title the run\'s own is left, as text');
});

test('a bundle must be a regular git bundle file: a directory, a link or a file without the header is refused (review L1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundles-'));
  mkdirSync(join(dir, 'dir.bundle'));
  writeFileSync(join(dir, 'real.bundle'), '# v2 git bundle\nrest');
  writeFileSync(join(dir, 'v3.bundle'), '# v3 git bundle\nrest');
  writeFileSync(join(dir, 'fake.bundle'), 'not a bundle at all');
  symlinkSync(join(dir, 'real.bundle'), join(dir, 'link.bundle'));
  const cli = join(import.meta.dirname, '..', 'harness', 'cli.mjs');
  writeFileSync(join(dir, 'entry.json'), JSON.stringify(withTarget()));
  const check = (bundle) => {
    writeFileSync(join(dir, 'v.json'), JSON.stringify(verdict({ targets: [target({ bundle })] })));
    return JSON.parse(spawnSync('node', [cli, 'guard-verdict', '--verdict', join(dir, 'v.json'), '--entry', join(dir, 'entry.json'), '--bundle-dir', dir], { encoding: 'utf8' }).stdout).outcome;
  };
  assert.equal(check('real.bundle'), 'READY_FOR_QA');
  assert.equal(check('v3.bundle'), 'READY_FOR_QA');
  for (const b of ['dir.bundle', 'fake.bundle', 'link.bundle', 'missing.bundle']) assert.equal(check(b), 'BLOCKED', b);
});
