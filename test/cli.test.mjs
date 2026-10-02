import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

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
