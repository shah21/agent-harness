import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectDebug } from '../harness/lib/queue.mjs';

const CLI = new URL('../harness/cli.mjs', import.meta.url).pathname;
const issue = (number, labels, body = 'It fails.') => ({ number, title: `Issue ${number}`, body, labels });

test('picks the lowest-numbered debug issue', () => {
  const s = selectDebug({ issues: [issue(5, ['debug']), issue(2, ['debug']), issue(1, ['agent'])] });
  assert.equal(s.issue.number, 2);
  assert.equal(s.skip, null);
  assert.equal(s.ref, null);
});

test('ignores running issues and issues without the label', () => {
  assert.deepEqual(selectDebug({ issues: [issue(1, ['debug', 'agent:running']), issue(2, ['bug'])] }), { issue: null });
  assert.deepEqual(selectDebug({ issues: [] }), { issue: null });
});

test('accepts label objects as returned by gh', () => {
  assert.equal(selectDebug({ issues: [issue(3, [{ name: 'debug' }])] }).issue.number, 3);
});

test('carries the ref, or a skip reason for a bad issue', () => {
  assert.equal(selectDebug({ issues: [issue(1, ['debug'], 'ref: v1.0\nbug')] }).ref, 'v1.0');
  const bad = selectDebug({ issues: [issue(1, ['debug'], 'ref: ../x\nbug')] });
  assert.equal(bad.ref, null);
  assert.match(bad.skip, /^bad issue: ref is not allowed/);
});

function cli(args, { env = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'debug-cli-'));
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    paths[name] = join(dir, name);
    writeFileSync(paths[name], typeof content === 'string' ? content : JSON.stringify(content));
  }
  const r = spawnSync('node', [CLI, ...args(paths, dir)], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { ...r, dir };
}

test('select-debug prints the selection', () => {
  const r = cli((p) => ['select-debug', '--issues', p.issues], { files: { issues: [issue(4, ['debug'], 'ref: main\nbug')] } });
  assert.equal(r.status, 0, r.stderr);
  const sel = JSON.parse(r.stdout);
  assert.equal(sel.issue.number, 4);
  assert.equal(sel.ref, 'main');
});

const targetConfig = { install: 'x', checks: { t: 'y' }, target: { repo: 'o/super', path: 'target' } };

test('debug-info prints the target and the ref', () => {
  const r = cli((p, dir) => ['debug-info', '--config', p.config, '--selection', p.sel, '--out', dir], {
    env: { HAS_TARGET_READ_TOKEN: 'true' },
    files: { config: targetConfig, sel: { issue: { number: 4 }, ref: 'v1.2.3' } },
  });
  assert.equal(r.stdout, 'repo=o/super\npath=target\nref=v1.2.3\n');
});

test('debug-info records a missing read token and prints nothing', () => {
  const r = cli((p, dir) => ['debug-info', '--config', p.config, '--selection', p.sel, '--out', dir], {
    env: { HAS_TARGET_READ_TOKEN: 'false' },
    files: { config: targetConfig, sel: { issue: { number: 4 }, ref: null } },
  });
  assert.equal(r.stdout, '');
  assert.match(readFileSync(join(r.dir, 'target-checkout.txt'), 'utf8'), /TARGET_READ_TOKEN secret missing/);
});

test('debug-info prints nothing without a target', () => {
  const r = cli((p, dir) => ['debug-info', '--config', p.config, '--selection', p.sel, '--out', dir], {
    files: { config: { install: 'x', checks: { t: 'y' } }, sel: { issue: { number: 4 }, ref: null } },
  });
  assert.equal(r.stdout, '');
  assert.equal(existsSync(join(r.dir, 'target-checkout.txt')), false);
});

test('debug-skip-verdict and debug-fallback-verdict are BLOCKED debug verdicts', () => {
  const files = { sel: { issue: { number: 4, title: 'T' }, ref: 'main', skip: 'bad issue: x' } };
  const skip = JSON.parse(cli((p) => ['debug-skip-verdict', '--selection', p.sel], { files }).stdout);
  assert.deepEqual([skip.mode, skip.outcome, skip.kind, skip.reasons, skip.issue], ['debug', 'BLOCKED', 'gate', ['bad issue: x'], 4]);
  const fb = JSON.parse(cli((p) => ['debug-fallback-verdict', '--selection', p.sel], { files }).stdout);
  assert.deepEqual([fb.mode, fb.outcome, fb.kind], ['debug', 'BLOCKED', 'harness']);
});

test('render-debug-comment renders the verdict', () => {
  const verdict = { mode: 'debug', outcome: 'BLOCKED', kind: 'gate', reasons: ['bad issue: x'], warnings: [], investigated: [], report: null };
  const r = cli((p) => ['render-debug-comment', '--verdict', p.v, '--run-url', 'https://example.test/run'], { files: { v: verdict } });
  assert.match(r.stdout, /BLOCKED\*\* \(gate\)/);
  assert.match(r.stdout, /<!-- agent-debug -->/);
});
