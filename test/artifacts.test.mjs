import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectArtifacts } from '../harness/lib/artifacts.mjs';

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'artifacts-src-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
const dest = () => join(mkdtempSync(join(tmpdir(), 'artifacts-out-')), 'artifacts');

test('copies matching files with their relative paths', () => {
  const projectDir = tree({ 'report/index.html': '<h1>', 'report/data/a.png': 'png', 'src/app.js': 'x' });
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['report/**'], destDir });
  assert.deepEqual(r, { files: 2, bytes: 7, skipped: 0 });
  assert.equal(readFileSync(join(destDir, 'report/index.html'), 'utf8'), '<h1>');
  assert.equal(readFileSync(join(destDir, 'report/data/a.png'), 'utf8'), 'png');
  assert.equal(existsSync(join(destDir, 'src/app.js')), false);
});

test('never looks inside .git or node_modules', () => {
  const projectDir = tree({ '.git/report/x': '1', 'node_modules/report/y': '2', 'report/z': '3' });
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['**/report/**'], destDir });
  assert.equal(r.files, 1);
  assert.equal(existsSync(join(destDir, 'report/z')), true);
});

test('does not follow symlinks', () => {
  const outside = tree({ 'secret.txt': 'secret' });
  const projectDir = tree({ 'report/real.txt': 'ok' });
  symlinkSync(join(outside, 'secret.txt'), join(projectDir, 'report/link.txt'));
  symlinkSync(outside, join(projectDir, 'report/linkdir'));
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['report/**'], destDir });
  assert.equal(r.files, 1);
  assert.equal(existsSync(join(destDir, 'report/link.txt')), false);
  assert.equal(existsSync(join(destDir, 'report/linkdir')), false);
});

test('stops at the file cap and says so', () => {
  const projectDir = tree({ 'r/a': '1', 'r/b': '2', 'r/c': '3' });
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['r/**'], destDir, limits: { maxFiles: 2, maxBytes: 1000 } });
  assert.deepEqual(r, { files: 2, bytes: 2, skipped: 1 });
  assert.match(readFileSync(join(destDir, 'TRUNCATED.txt'), 'utf8'), /1 matching file\(s\) skipped/);
});

test('skips files that would exceed the byte cap but keeps smaller later ones', () => {
  const projectDir = tree({ 'r/a': '12345', 'r/b': '1234567890', 'r/c': '1' });
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['r/**'], destDir, limits: { maxFiles: 10, maxBytes: 6 } });
  assert.deepEqual(r, { files: 2, bytes: 6, skipped: 1 });
  assert.equal(existsSync(join(destDir, 'r/b')), false);
  assert.equal(existsSync(join(destDir, 'TRUNCATED.txt')), true);
});

test('empties the destination first, so nothing planted there survives', () => {
  const projectDir = tree({ 'r/a': '1' });
  const destDir = dest();
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'planted.txt'), 'x');
  collectArtifacts({ projectDir, globs: ['r/**'], destDir });
  assert.equal(existsSync(join(destDir, 'planted.txt')), false);
  assert.equal(existsSync(join(destDir, 'r/a')), true);
});

test('no matches → empty result and no TRUNCATED.txt', () => {
  const projectDir = tree({ 'src/a': '1' });
  const destDir = dest();
  assert.deepEqual(collectArtifacts({ projectDir, globs: ['report/**'], destDir }), { files: 0, bytes: 0, skipped: 0 });
  assert.equal(existsSync(join(destDir, 'TRUNCATED.txt')), false);
});

test('skips unreadable directories and keeps going', { skip: process.getuid?.() === 0 && 'root can read anything' }, () => {
  const projectDir = tree({ 'r/a/x': '1', 'r/b/y': '2' });
  chmodSync(join(projectDir, 'r/a'), 0o000);
  const destDir = dest();
  const errors = [];
  try {
    const r = collectArtifacts({ projectDir, globs: ['r/**'], destDir, onError: (e) => errors.push(e) });
    assert.equal(r.files, 1);
    assert.equal(existsSync(join(destDir, 'r/b/y')), true);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0].message), /r\/a/);
  } finally {
    chmodSync(join(projectDir, 'r/a'), 0o755);
  }
});
