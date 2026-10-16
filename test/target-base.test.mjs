import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseTaskRef } from '../harness/lib/issue.mjs';
import { selectNext } from '../harness/lib/queue.mjs';
import { loadConfig } from '../harness/lib/config.mjs';
import { prepareTarget } from '../harness/lib/target-run.mjs';
import { makeTargetProject } from './helpers/target-fixture.mjs';
import { makeTargetsFixture } from './helpers/publish-targets-fixture.mjs';

const CLI = new URL('../harness/cli.mjs', import.meta.url).pathname;
const SCRIPT = new URL('../harness/publish-targets.mjs', import.meta.url).pathname;
const STUBS = new URL('./stubs', import.meta.url).pathname;

const dir = mkdtempSync(join(tmpdir(), 'target-base-'));
const file = (name, data) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(data));
  return p;
};
const cliEnv = (env, ...args) =>
  execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

const issue = (number, task, labels, body) => ({
  number, title: `T${task}`, body, labels: labels.map((name) => ({ name })),
});

test('no base line changes nothing', () => {
  assert.deepEqual(parseTaskRef('plan: docs/p.md\ntask: 1\n'), { plan: 'docs/p.md', task: 1 });
  const s = selectNext({ issues: [issue(4, 1, ['agent'], 'plan: docs/p.md\ntask: 1')], prs: [], defaultBranch: 'main' });
  assert.equal('targetBase' in s, false);
});

test('base is the checkout ref and PR base', () => {
  assert.deepEqual(parseTaskRef('plan: docs/p.md\ntask: 1\nbase: release/v2\n'), { plan: 'docs/p.md', task: 1, base: 'release/v2' });

  const s = selectNext({
    issues: [issue(4, 1, ['agent'], 'plan: docs/p.md\ntask: 1\nbase: release/v2')], prs: [], defaultBranch: 'main',
  });
  assert.equal(s.targetBase, 'release/v2');

  const targetConfig = file('target.config.json', { install: 'x', checks: { t: 'y' }, target: { repo: 'o/super', path: 'target' } });
  const sel = file('sel.json', { targetBase: 'release/v2' });
  const out = mkdtempSync(join(tmpdir(), 'target-base-out-'));
  assert.equal(
    cliEnv({ HAS_TARGET_READ_TOKEN: 'true', HAS_TARGET_PUSH_TOKEN: 'true' }, 'target-info', '--config', targetConfig, '--selection', sel, '--out', out),
    'repo=o/super\npath=target\nref=release/v2\n',
  );

  const { projectDir } = makeTargetProject({ ref: 'release/v2', branches: ['release/v2'] });
  const config = loadConfig(readFileSync(join(projectDir, 'agent.config.json'), 'utf8'));
  const outDir = mkdtempSync(join(tmpdir(), 'target-base-prep-'));
  const target = prepareTarget({
    projectDir, outDir, target: config.target, issue: { number: 7 }, task: 1, taskTitle: 'Add greeting',
    parentBases: null, issueBase: 'release/v2',
  });
  assert.deepEqual(Object.fromEntries(target.repos.map((r) => [r.repo, r.base])), { 'o/sub': 'release/v2', 'o/super': 'release/v2' });
});

test('a stacked parent wins over base', () => {
  const { projectDir } = makeTargetProject({ ref: 'release/v2', branches: ['release/v2'] });
  const config = loadConfig(readFileSync(join(projectDir, 'agent.config.json'), 'utf8'));
  const outDir = mkdtempSync(join(tmpdir(), 'target-base-prep-'));
  const target = prepareTarget({
    projectDir, outDir, target: config.target, issue: { number: 7 }, task: 2, taskTitle: 'Add greeting',
    parentBases: { 'o/super': 'fix/prev' }, issueBase: 'release/v2',
  });
  assert.deepEqual(Object.fromEntries(target.repos.map((r) => [r.repo, r.base])), { 'o/sub': 'release/v2', 'o/super': 'fix/prev' });
});

function env(d, remoteTemplate, extra = {}) {
  const log = join(d, 'gh.log');
  writeFileSync(log, '');
  return {
    log,
    env: {
      ...process.env, PATH: `${STUBS}:${process.env.PATH}`, GH_LOG: log,
      TARGET_PUSH_TOKEN: 'tok', TARGET_PUSH_REMOTE_TEMPLATE: remoteTemplate, HOOK_RAN: join(d, 'hook-ran'), ...extra,
    },
  };
}

const readyVerdict = (targets) => ({
  outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings: [],
  issue: 7, issueTitle: 'Task 1', plan: 'docs/p.md', task: 1, taskTitle: 'Add greeting',
  baseBranch: 'main', branch: 'agent/issue-7', model: 'sonnet', commits: 2, consumerCommits: 0,
  checks: {}, report: { summary: 's', selfReview: 'r', knownIssues: 'None' }, reportText: '', targets,
});

test('missing base branch falls back to the default branch', () => {
  const fx = makeTargetsFixture();
  const targets = fx.targets.map((t) => ({ ...t, base: 'release/v2' }));
  writeFileSync(join(fx.dir, 'verdict.json'), JSON.stringify(readyVerdict(targets)));
  const { log, env: e } = env(fx.dir, fx.remoteTemplate, { GH_MISSING_BRANCH_REPO: 'o/sub' });
  const out = join(fx.dir, 'prs.json');
  const r = spawnSync(process.execPath, [SCRIPT, '--verdict', join(fx.dir, 'verdict.json'), '--bundle-dir', fx.dir, '--out', out], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  const gotLog = readFileSync(log, 'utf8');
  const creates = gotLog.split('\n').filter((l) => l.startsWith('gh pr create'));
  assert.match(creates[0], /--repo o\/sub --base main /);
  assert.match(creates[1], /--repo o\/super --base release\/v2 /);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).map((p) => [p.repo, p.base]), [['o/sub', 'main'], ['o/super', 'release/v2']]);
});

test('rejects unsafe base names', () => {
  for (const value of ['../x', 'Release/V2', 'x.lock']) {
    assert.equal(parseTaskRef(`plan: docs/p.md\ntask: 1\nbase: ${value}`).error, `base is not allowed: ${value}`);
  }
});
