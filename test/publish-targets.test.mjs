import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTargetsFixture, remoteHasBranch } from './helpers/publish-targets-fixture.mjs';
import { parseTargetsMarker } from '../harness/lib/target.mjs';

const SCRIPT = new URL('../harness/publish-targets.mjs', import.meta.url).pathname;
const PUBLISH = new URL('../harness/publish.sh', import.meta.url).pathname;
const STUBS = new URL('./stubs', import.meta.url).pathname;

const readyVerdict = (targets) => ({
  outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings: [],
  issue: 7, issueTitle: 'Task 1', plan: 'docs/p.md', task: 1, taskTitle: 'Add greeting',
  baseBranch: 'main', branch: 'agent/issue-7', model: 'sonnet', commits: 2, consumerCommits: 0,
  checks: {}, report: { summary: 's', selfReview: 'r', knownIssues: 'None' }, reportText: '', targets,
});

function env(dir, remoteTemplate, extra = {}) {
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  return {
    log,
    env: {
      ...process.env, PATH: `${STUBS}:${process.env.PATH}`, GH_LOG: log,
      TARGET_PUSH_TOKEN: 'tok', TARGET_PUSH_REMOTE_TEMPLATE: remoteTemplate, HOOK_RAN: join(dir, 'hook-ran'), ...extra,
    },
  };
}

function runScript(extra = {}) {
  const fx = makeTargetsFixture();
  writeFileSync(join(fx.dir, 'verdict.json'), JSON.stringify(readyVerdict(fx.targets)));
  const { log, env: e } = env(fx.dir, fx.remoteTemplate, extra);
  const out = join(fx.dir, 'prs.json');
  const r = spawnSync(process.execPath, [SCRIPT, '--verdict', join(fx.dir, 'verdict.json'), '--bundle-dir', fx.dir, '--out', out], { encoding: 'utf8', env: e });
  return { ...fx, r, out, log: readFileSync(log, 'utf8') };
}

test('pushes submodules before the superproject and opens draft PRs', () => {
  const { r, dir, out, log } = runScript();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(remoteHasBranch(dir, 'o/sub', 'fix/x'));
  assert.ok(remoteHasBranch(dir, 'o/super', 'fix/x'));
  const creates = log.split('\n').filter((l) => l.startsWith('gh pr create'));
  assert.equal(creates.length, 2);
  assert.match(creates[0], /--draft --repo o\/sub --base main --head fix\/x --title Title o\/sub/);
  assert.match(creates[1], /--repo o\/super /);
  assert.match(log, /gh pr edit 9 --repo o\/sub --body-file/);
  assert.match(log, /- o\/super#9/);
  assert.doesNotMatch(log, /agent-related/);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).map((p) => [p.repo, p.role, p.number, p.base]), [['o/sub', 'sub', 9, 'main'], ['o/super', 'super', 9, 'main']]);
  assert.equal(existsSync(join(dir, 'hook-ran')), false);
});

test('an existing PR is edited, not duplicated', () => {
  const { r, log } = runScript({ GH_PR_LIST: '{"number":45,"url":"https://github.com/o/sub/pull/45"}' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(log, /gh pr create/);
  assert.match(log, /gh pr edit 45 --repo o\/sub --base main --title Title o\/sub/);
});

test('a failure after one PR lists the opened PR', () => {
  const { r, out } = runScript({ GH_FAIL_PR_CREATE_REPO: 'o/super' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /target publish failed at pr for o\/super/);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).map((p) => p.repo), ['o/sub']);
});

test('refuses an unsafe branch name', () => {
  const fx = makeTargetsFixture();
  const targets = fx.targets.map((t) => ({ ...t, branch: 'x;rm' }));
  writeFileSync(join(fx.dir, 'verdict.json'), JSON.stringify(readyVerdict(targets)));
  const { env: e } = env(fx.dir, fx.remoteTemplate);
  const r = spawnSync(process.execPath, [SCRIPT, '--verdict', join(fx.dir, 'verdict.json'), '--bundle-dir', fx.dir, '--out', join(fx.dir, 'o.json')], { encoding: 'utf8', env: e });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing branch name "x;rm"/);
});

function runPublish(verdictOverrides, extra = {}) {
  const fx = makeTargetsFixture();
  const verdict = { ...readyVerdict(fx.targets), ...verdictOverrides(fx.targets) };
  writeFileSync(join(fx.dir, 'verdict.json'), JSON.stringify(verdict));
  const { log, env: e } = env(fx.dir, fx.remoteTemplate, {
    VERDICT: join(fx.dir, 'verdict.json'), REPO: 'o/r', GH_TOKEN: 'x', RUN_URL: 'https://run',
    BUNDLE: join(fx.dir, 'branch.bundle'), BUNDLE_DIR: fx.dir, PUSH_REMOTE: join(fx.dir, 'none.git'), ...extra,
  });
  const r = spawnSync('bash', [PUBLISH], { encoding: 'utf8', env: e });
  return { ...fx, r, log: readFileSync(log, 'utf8') };
}

test('publish.sh: READY with targets and no consumer commits opens only target PRs and comments the marker', () => {
  const { r, log } = runPublish(() => ({}));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(log, /gh pr create .*--repo o\/r /);
  assert.match(log, /--add-label agent:ready/);
  const marker = parseTargetsMarker(log);
  assert.deepEqual(marker.map((p) => [p.repo, p.role]), [['o/sub', 'sub'], ['o/super', 'super']]);
});

test('publish.sh: BLOCKED with targets pushes nothing to target repositories', () => {
  const { r, dir, log } = runPublish(() => ({ outcome: 'BLOCKED', kind: 'gate', reasons: ['x'], report: null }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteHasBranch(dir, 'o/super', 'fix/x'), false);
  assert.match(log, /were not pushed; their bundles are in the run artifact/);
});

test('publish.sh: a target failure ends BLOCKED and lists PRs already opened', () => {
  const { r, log } = runPublish(() => ({}), { GH_FAIL_PR_CREATE_REPO: 'o/super' });
  assert.notEqual(r.status, 0);
  assert.match(log, /--add-label agent:blocked/);
  assert.match(log, /publishing failed at step: targets/);
  assert.match(log, /Opened before the failure:\n- `o\/sub` #9: https:\/\/github\.com\/o\/r\/pull\/9/);
});
