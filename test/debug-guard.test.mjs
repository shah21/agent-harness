import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshot, enforceReadOnly } from '../harness/lib/debug-guard.mjs';

const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const git = (dir, ...a) => execFileSync('git', [...ID, ...a], { cwd: dir, encoding: 'utf8' }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, '.gitignore'), 'build/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

test('no change reverts nothing', () => {
  const dir = repo();
  const snaps = snapshot([dir]);
  assert.deepEqual(enforceReadOnly(snaps), []);
});

test('a tracked edit and an untracked file are reverted', () => {
  const dir = repo();
  const snaps = snapshot([dir]);
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  writeFileSync(join(dir, 'junk.txt'), 'x\n');
  assert.deepEqual(enforceReadOnly(snaps), [dir]);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(existsSync(join(dir, 'junk.txt')), false);
});

test('a new commit is reverted', () => {
  const dir = repo();
  const snaps = snapshot([dir]);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git(dir, 'commit', '-qam', 'sneaky');
  enforceReadOnly(snaps);
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n');
});

test('a moved branch is restored', () => {
  const dir = repo();
  const snaps = snapshot([dir]);
  git(dir, 'checkout', '-q', '-b', 'other');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'on other');
  enforceReadOnly(snaps);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(existsSync(join(dir, 'b.txt')), false);
});

test('a detached HEAD is restored', () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '--detach');
  const snaps = snapshot([dir]);
  const head = snaps[0].head;
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git(dir, 'commit', '-qam', 'detached commit');
  enforceReadOnly(snaps);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
});

test('ignored files are left alone', () => {
  const dir = repo();
  const snaps = snapshot([dir]);
  execFileSync('mkdir', ['-p', join(dir, 'build')]);
  writeFileSync(join(dir, 'build', 'out.js'), 'x\n');
  assert.deepEqual(enforceReadOnly(snaps), []);
  assert.equal(existsSync(join(dir, 'build', 'out.js')), true);
});

test('every directory in the list is checked', () => {
  const a = repo();
  const b = repo();
  const snaps = snapshot([a, b]);
  writeFileSync(join(b, 'a.txt'), 'changed\n');
  assert.deepEqual(enforceReadOnly(snaps), [b]);
});
