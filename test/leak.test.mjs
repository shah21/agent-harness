import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseBlocklist, scanText, scanDir } from '../harness/lib/leak.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'leak-'));

test('parseBlocklist lowercases, drops comments, blanks and very short terms, and de-duplicates', () => {
  assert.deepEqual(parseBlocklist('# names\nAcmeCorp\n\nacmecorp\nab\n  Project-X  \n'), ['acmecorp', 'project-x']);
});

test('scanText reports lines, case-insensitively, without the term', () => {
  const hits = scanText('f.md', 'clean\nsee AcmeCorp here\nclean', ['acmecorp']);
  assert.deepEqual(hits, [{ path: 'f.md', line: 2 }]);
});

test('scanDir walks files, skips .git and node_modules, and flags a matching file name', () => {
  const root = tmp();
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'docs', 'a.md'), 'nothing\nmentions project-x\n');
  writeFileSync(join(root, '.git', 'cfg'), 'project-x');
  writeFileSync(join(root, 'node_modules', 'm.js'), 'project-x');
  writeFileSync(join(root, 'project-x-notes.txt'), 'harmless');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 112, 114, 111, 106, 101, 99, 116, 45, 120]));
  const hits = scanDir(root, ['project-x']);
  assert.deepEqual(hits.map((h) => [h.path, h.line]).sort(), [['docs/a.md', 2], ['project-x-notes.txt', 0]]);
});

test('the CLI exits 1 on a hit, prints no term, and exits 0 when clean', () => {
  const root = tmp();
  const bl = join(tmp(), 'blocklist.txt');
  writeFileSync(bl, 'zzsecretname\n');
  writeFileSync(join(root, 'x.md'), 'ok\nzzsecretname\n');
  const cli = join(import.meta.dirname, '..', 'harness', 'cli.mjs');
  const bad = spawnSync('node', [cli, 'leak-scan', '--blocklist', bl, '--root', root], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, 'x.md:2\n');
  assert.ok(!/zzsecretname/.test(bad.stdout + bad.stderr));
  writeFileSync(join(root, 'x.md'), 'ok\n');
  const ok = spawnSync('node', [cli, 'leak-scan', '--blocklist', bl, '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
});
