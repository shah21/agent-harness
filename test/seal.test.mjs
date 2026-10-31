import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, lstatSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeypair, sealDir, openSealed, tagFor, assertSafeNames, CryptError } from '../harness/lib/crypt.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'seal-'));
function fixture() {
  const dir = tmp();
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'report.txt'), 'PLAINTEXT-MARKER-12345 the quick brown fox\n');
  writeFileSync(join(dir, 'nested', 'a.json'), '{"k":"PLAINTEXT-MARKER-12345"}');
  return dir;
}

test('a keypair is two base64 strings that differ every time', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  assert.match(a.publicKey, /^[A-Za-z0-9+/]+=*$/);
  assert.match(a.privateKey, /^[A-Za-z0-9+/]+=*$/);
  assert.notEqual(a.publicKey, b.publicKey);
});

test('seal and open round trip, and the sealed file hides the plaintext', async () => {
  const { publicKey, privateKey } = generateKeypair();
  const src = fixture();
  const sealed = join(tmp(), 'out.sealed');
  await sealDir(src, sealed, publicKey, { aad: '1:0' });
  const bytes = readFileSync(sealed);
  assert.ok(!bytes.includes('PLAINTEXT-MARKER-12345'));
  assert.ok(!bytes.includes('report.txt'));
  const dest = tmp();
  await openSealed(sealed, dest, privateKey, { aad: '1:0' });
  assert.equal(readFileSync(join(dest, 'report.txt'), 'utf8'), readFileSync(join(src, 'report.txt'), 'utf8'));
  assert.equal(readFileSync(join(dest, 'nested', 'a.json'), 'utf8'), '{"k":"PLAINTEXT-MARKER-12345"}');
});

test('two seals of the same directory differ, because every seal uses a fresh ephemeral key', async () => {
  const { publicKey } = generateKeypair();
  const src = fixture();
  const a = join(tmp(), 'a.sealed');
  const b = join(tmp(), 'b.sealed');
  await sealDir(src, a, publicKey);
  await sealDir(src, b, publicKey);
  assert.notDeepEqual(readFileSync(a), readFileSync(b));
});

test('only the matching private key opens it; a wrong key, a wrong aad and damage are refused, nothing is unpacked', async () => {
  const mine = generateKeypair();
  const other = generateKeypair();
  const sealed = join(tmp(), 'out.sealed');
  await sealDir(fixture(), sealed, mine.publicKey, { aad: '1:0' });
  const refuse = async (file, key, opts) => {
    const dest = tmp();
    await assert.rejects(() => openSealed(file, dest, key, opts), (e) => e instanceof CryptError && /decryption failed/.test(e.message));
    assert.deepEqual(readdirSync(dest), []);
  };
  await refuse(sealed, other.privateKey, { aad: '1:0' });
  await refuse(sealed, mine.privateKey, { aad: '1:1' });
  await refuse(sealed, mine.privateKey, {});
  const bytes = readFileSync(sealed);
  bytes[bytes.length - 40] ^= 0xff;
  const damaged = join(tmp(), 'bad.sealed');
  writeFileSync(damaged, bytes);
  await refuse(damaged, mine.privateKey, { aad: '1:0' });
});

test('keys that are not keys, and files that are not sealed files, are refused with fixed messages', async () => {
  const { publicKey, privateKey } = generateKeypair();
  await assert.rejects(() => sealDir(fixture(), join(tmp(), 'x'), 'zzbad-key'), (e) => e instanceof CryptError && !/zzbad/.test(e.message));
  const f = join(tmp(), 'x.sealed');
  writeFileSync(f, Buffer.alloc(200));
  await assert.rejects(() => openSealed(f, tmp(), privateKey), /not an encrypted run file/);
  await assert.rejects(() => openSealed(f, tmp(), 'zzbad-key'), (e) => e instanceof CryptError && !/zzbad/.test(e.message));
  const sealed = join(tmp(), 'ok.sealed');
  await sealDir(fixture(), sealed, publicKey);
  await assert.rejects(() => openSealed(sealed, tmp(), publicKey), (e) => e instanceof CryptError);
});

test('links are refused by default, in both directions, and allowed only when asked', async () => {
  const { publicKey, privateKey } = generateKeypair();
  const src = fixture();
  symlinkSync('/etc/hosts', join(src, 'link'));
  await assert.rejects(() => sealDir(src, join(tmp(), 'o.sealed'), publicKey), /symbolic link/);

  const sealed = join(tmp(), 'links.sealed');
  await sealDir(src, sealed, publicKey, { allowLinks: true });
  const refused = tmp();
  await assert.rejects(() => openSealed(sealed, refused, privateKey), /unsafe archive/);
  assert.deepEqual(readdirSync(refused), [], 'a refused archive leaves nothing behind');
  const allowed = tmp();
  await openSealed(sealed, allowed, privateKey, { allowLinks: true });
  assert.ok(lstatSync(join(allowed, 'link')).isSymbolicLink());
});

test('a hard link smuggled into an archive is refused too', async () => {
  const { publicKey, privateKey } = generateKeypair();
  const src = fixture();
  linkSync(join(src, 'report.txt'), join(src, 'hard.txt'));
  const sealed = join(tmp(), 'hard.sealed');
  await sealDir(src, sealed, publicKey, { allowLinks: true });
  const dest = tmp();
  await assert.rejects(() => openSealed(sealed, dest, privateKey), /unsafe archive/);
  assert.deepEqual(readdirSync(dest), []);
});

test('member names that climb out of the target or are absolute are rejected', () => {
  assert.doesNotThrow(() => assertSafeNames(['./', './a.txt', './nested/', './nested/b.json']));
  for (const bad of [['../x'], ['./a/../../x'], ['/etc/passwd'], ['./ok', '..'], ['a\0b']]) {
    assert.throws(() => assertSafeNames(bad), (e) => e instanceof CryptError && /unsafe archive/.test(e.message), JSON.stringify(bad));
  }
});

test('tagFor: a stable, secret-keyed name that cannot be computed without the secret', () => {
  const secret = 'a-long-enough-slot-secret-0001';
  const t = tagFor(secret, '777', 'pub');
  assert.match(t, /^[0-9a-f]{24}$/);
  assert.equal(tagFor(secret, '777', 'pub'), t);
  assert.notEqual(tagFor(secret, '777', 'bundle'), t);
  assert.notEqual(tagFor(secret, '778', 'pub'), t);
  assert.notEqual(tagFor('another-long-enough-secret-0002', '777', 'pub'), t);
  assert.ok(!t.includes(secret.slice(0, 8)));
  assert.throws(() => tagFor('zzkey', '777', 'pub'), (e) => e instanceof CryptError && !/zzkey/.test(e.message));
  assert.throws(() => tagFor(secret, '', 'pub'), CryptError);
  assert.throws(() => tagFor(secret, '777', 'bad label!'), CryptError);
  assert.ok(!existsSync('/nonexistent'));
});
