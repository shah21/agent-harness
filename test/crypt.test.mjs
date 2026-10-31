import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptDir, decryptToDir } from '../harness/lib/crypt.mjs';

const KEY = 'a-long-enough-test-secret-1234';
const tmp = () => mkdtempSync(join(tmpdir(), 'crypt-'));
function fixture() {
  const dir = tmp();
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'report.txt'), 'PLAINTEXT-MARKER-12345 the quick brown fox\n');
  writeFileSync(join(dir, 'nested', 'a.json'), '{"k":"PLAINTEXT-MARKER-12345"}');
  return dir;
}

test('round trip restores every file', async () => {
  const src = fixture();
  const enc = join(tmp(), 'out.enc');
  await encryptDir(src, enc, KEY);
  const dest = tmp();
  await decryptToDir(enc, dest, KEY);
  assert.equal(readFileSync(join(dest, 'report.txt'), 'utf8'), readFileSync(join(src, 'report.txt'), 'utf8'));
  assert.equal(readFileSync(join(dest, 'nested', 'a.json'), 'utf8'), '{"k":"PLAINTEXT-MARKER-12345"}');
});

test('the encrypted file does not contain the plaintext', async () => {
  const enc = join(tmp(), 'out.enc');
  await encryptDir(fixture(), enc, KEY);
  const bytes = readFileSync(enc);
  assert.ok(!bytes.includes('PLAINTEXT-MARKER-12345'));
  assert.ok(!bytes.includes('report.txt'));
});

test('a wrong key and a damaged file are both refused, and nothing is unpacked', async () => {
  const enc = join(tmp(), 'out.enc');
  await encryptDir(fixture(), enc, KEY);
  const wrong = tmp();
  await assert.rejects(() => decryptToDir(enc, wrong, 'another-long-enough-secret-9876'), /decryption failed/);
  assert.ok(!existsSync(join(wrong, 'report.txt')));
  const bytes = readFileSync(enc);
  bytes[bytes.length - 40] ^= 0xff;
  const damaged = join(tmp(), 'bad.enc');
  writeFileSync(damaged, bytes);
  const dest = tmp();
  await assert.rejects(() => decryptToDir(damaged, dest, KEY), /decryption failed/);
  assert.ok(!existsSync(join(dest, 'report.txt')));
});

test('a short or missing key is refused, and errors never echo the key', async () => {
  const enc = join(tmp(), 'out.enc');
  await assert.rejects(() => encryptDir(fixture(), enc, 'zzkey'), (e) => !/zzkey/.test(e.message));
  await assert.rejects(() => encryptDir(fixture(), enc, undefined), /key/);
});

test('symbolic links are refused, and the output cannot sit inside the directory', async () => {
  const dir = fixture();
  symlinkSync('/etc/hosts', join(dir, 'link'));
  await assert.rejects(() => encryptDir(dir, join(tmp(), 'o.enc'), KEY), /symbolic link/);
  const clean = fixture();
  await assert.rejects(() => encryptDir(clean, join(clean, 'o.enc'), KEY), /inside/);
});

test('a file that is not an encrypted run file is refused', async () => {
  const f = join(tmp(), 'x.enc');
  writeFileSync(f, Buffer.alloc(100));
  await assert.rejects(() => decryptToDir(f, tmp(), KEY), /not an encrypted run file/);
});

test('the output is bound to its run and index: a swapped or unbound file is refused (M6)', async () => {
  const enc = join(tmp(), 'out.enc');
  await encryptDir(fixture(), enc, KEY, { aad: '777:0' });
  const ok = tmp();
  await decryptToDir(enc, ok, KEY, { aad: '777:0' });
  assert.ok(existsSync(join(ok, 'report.txt')));
  for (const aad of ['777:1', '778:0', undefined]) {
    const dest = tmp();
    await assert.rejects(() => decryptToDir(enc, dest, KEY, { aad }), /decryption failed/);
    assert.ok(!existsSync(join(dest, 'report.txt')));
  }
});

test('a failed unpack leaves no link behind, even when tar stops part way', async () => {
  const src = tmp();
  mkdirSync(join(src, 'sub'));
  writeFileSync(join(src, 'sub', 'f.txt'), 'x');
  symlinkSync('/etc/hostname', join(src, 'l'));
  const enc = join(tmp(), 'out.enc');
  await encryptDir(src, enc, KEY, { allowLinks: true });
  const dest = tmp();
  mkdirSync(join(dest, 'sub'));
  chmodSync(join(dest, 'sub'), 0o500); // extracting sub/f.txt fails
  try {
    await assert.rejects(decryptToDir(enc, dest, KEY));
    assert.throws(() => lstatSync(join(dest, 'l')), 'the link is gone');
  } finally {
    if (existsSync(join(dest, 'sub'))) chmodSync(join(dest, 'sub'), 0o700);
  }
});
