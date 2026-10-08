import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { targetsMarker } from '../harness/lib/target.mjs';

const CLI = new URL('../harness/cli.mjs', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'cli-'));
const file = (name, data) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(data));
  return p;
};
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const issues = file('issues.json', [{ number: 4, title: 'T', body: 'plan: docs/p.md\ntask: 2', labels: [{ name: 'agent' }] }]);
const prs = file('prs.json', []);

test('select prints the selection', () => {
  const s = JSON.parse(cli('select', '--issues', issues, '--prs', prs, '--default-branch', 'main'));
  assert.equal(s.issue.number, 4);
  assert.equal(s.base, 'main');
  assert.equal(s.skip, null);
});

test('skip-verdict and fallback-verdict produce publishable BLOCKED verdicts', () => {
  const selection = file('sel.json', { issue: { number: 4, title: 'T', body: '', labels: ['agent'] }, plan: 'docs/p.md', task: 2, base: 'main', skip: 'upstream task 1 blocked (#3)' });
  const skip = JSON.parse(cli('skip-verdict', '--selection', selection));
  assert.equal(skip.outcome, 'BLOCKED');
  assert.equal(skip.kind, 'gate');
  assert.deepEqual(skip.reasons, ['upstream task 1 blocked (#3)']);
  assert.equal(skip.issue, 4);
  assert.equal(skip.commits, 0);
  assert.equal(skip.branch, 'agent/issue-4');
  const fallback = JSON.parse(cli('fallback-verdict', '--selection', selection));
  assert.equal(fallback.kind, 'harness');
  assert.match(fallback.reasons[0], /ended without a verdict/);
});

test('render-comment prints markdown', () => {
  const selection = file('sel2.json', { issue: { number: 4, title: 'T', body: '', labels: [] }, plan: null, task: null, base: 'main', skip: 'bad task reference: x' });
  const verdict = join(dir, 'verdict.json');
  writeFileSync(verdict, cli('skip-verdict', '--selection', selection));
  const out = cli('render-comment', '--verdict', verdict, '--run-url', 'https://run');
  assert.match(out, /BLOCKED\*\* \(gate\)/);
  assert.match(out, /https:\/\/run/);
});

test('unknown command exits 2', () => {
  const r = spawnSync(process.execPath, [CLI, 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test('merged-issue prints the issue number for a merged agent PR and nothing otherwise', () => {
  const ev = (over) => file('event.json', { pull_request: { merged: true, head: { ref: 'agent/issue-12', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } }, body: '<!-- agent-task plan=docs/p.md task=2 issue=12 -->', ...over } });
  assert.equal(cli('merged-issue', '--event', ev({})).trim(), '12');
  assert.equal(cli('merged-issue', '--event', ev({ merged: false })).trim(), '');
});

const cliEnv = (env, ...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const targetConfig = file('target.config.json', { install: 'x', checks: { t: 'y' }, target: { repo: 'o/super', path: 'target' } });
const plainConfig = file('plain.config.json', { install: 'x', checks: { t: 'y' } });
const both = { HAS_TARGET_READ_TOKEN: 'true', HAS_TARGET_PUSH_TOKEN: 'true' };

test('target-info prints repo, path and the stacked ref', () => {
  const sel = file('tsel.json', { targets: { superBranch: 'fix/prev', bases: {} } });
  const out = mkdtempSync(join(tmpdir(), 'cli-out-'));
  assert.equal(cliEnv(both, 'target-info', '--config', targetConfig, '--selection', sel, '--out', out), 'repo=o/super\npath=target\nref=fix/prev\n');
  const plain = file('psel.json', {});
  assert.equal(cliEnv(both, 'target-info', '--config', targetConfig, '--selection', plain, '--out', out), 'repo=o/super\npath=target\nref=\n');
});

test('target-info prints nothing without a target', () => {
  const out = mkdtempSync(join(tmpdir(), 'cli-out-'));
  assert.equal(cliEnv(both, 'target-info', '--config', plainConfig, '--selection', file('s0.json', {}), '--out', out), '');
  assert.equal(existsSync(join(out, 'target-checkout.txt')), false);
});

test('target-info records missing secrets instead of printing a repo', () => {
  const out = mkdtempSync(join(tmpdir(), 'cli-out-'));
  assert.equal(cliEnv({ HAS_TARGET_READ_TOKEN: 'true', HAS_TARGET_PUSH_TOKEN: 'false' }, 'target-info', '--config', targetConfig, '--selection', file('s1.json', {}), '--out', out), '');
  assert.equal(readFileSync(join(out, 'target-checkout.txt'), 'utf8'), 'target configured but TARGET_READ_TOKEN or TARGET_PUSH_TOKEN secret missing\n');
});

const markerPrs = [{ repo: 'o/super', number: 10, branch: 'fix/one', base: 'main', role: 'super' }];
const readyFile = file('ready.json', [{ number: 1, body: 'plan: docs/p.md\ntask: 1', comments: [{ body: `✅ **READY_FOR_QA** — u\n\n${targetsMarker(markerPrs)}` }] }]);

test('select uses --ready for target stacking', () => {
  const s = JSON.parse(cli('select', '--issues', issues, '--prs', prs, '--default-branch', 'main', '--ready', readyFile));
  assert.deepEqual(s.targets, { superBranch: 'fix/one', bases: { 'o/super': 'fix/one' } });
});

test('targets-to-check lists superproject PRs', () => {
  assert.deepEqual(JSON.parse(cli('targets-to-check', '--ready', readyFile)), [{ issue: 1, repo: 'o/super', number: 10 }]);
});

test('render-comment accepts --target-prs', () => {
  const v = file('rv.json', { outcome: 'READY_FOR_QA', warnings: [], checks: {} });
  const tprs = file('tprs.json', [{ ...markerPrs[0], url: 'https://github.com/o/super/pull/10' }]);
  const c = cli('render-comment', '--verdict', v, '--run-url', 'https://run', '--target-prs', tprs);
  assert.match(c, /READY_FOR_QA\*\* — `https:\/\/github\.com\/o\/super\/pull\/10`/);
  assert.match(c, /<!-- agent-targets /);
});
