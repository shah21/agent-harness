import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
  assert.equal(r.stdout, 'skipped=true\n', 'only the flag the workflow needs: step outputs and env values can be printed');
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

test('encrypt and decrypt accept --aad and refuse a mismatch', () => {
  const src = tmp();
  writeFileSync(join(src, 'a.txt'), 'hello');
  const holder = tmp();
  const enc = join(holder, 'o.enc');
  const env = { RUN_KEY: 'a-long-enough-test-secret-1234' };
  assert.equal(run(['encrypt', '--dir', src, '--out', enc, '--aad', '9:1'], env).status, 0);
  assert.equal(run(['decrypt', '--in', enc, '--dir', join(holder, 'bad'), '--aad', '9:2'], env).status, 1);
  assert.equal(run(['decrypt', '--in', enc, '--dir', join(holder, 'good'), '--aad', '9:1'], env).status, 0);
  assert.equal(readFileSync(join(holder, 'good', 'a.txt'), 'utf8'), 'hello');
});

test('an unexpected failure prints a fixed message, never a path (M8)', () => {
  const env = { RUN_KEY: 'a-long-enough-test-secret-1234' };
  const e = run(['encrypt', '--dir', '/nonexistent/zzsecretdir', '--out', join(tmp(), 'o.enc')], env);
  assert.equal(e.status, 1);
  assert.equal(e.stderr, 'encryption failed\n');
  const d = run(['decrypt', '--in', '/nonexistent/zzsecretfile.enc', '--dir', join(tmp(), 'd')], env);
  assert.equal(d.status, 1);
  assert.equal(d.stderr, 'decryption failed\n');
});
