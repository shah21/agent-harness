import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = join(import.meta.dirname, '..', 'harness', 'cli.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'sealcli-'));
const run = (args, env = {}) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const source = () => {
  const d = tmp();
  writeFileSync(join(d, 'a.txt'), 'hello');
  return d;
};

test('keygen writes a public and a private key file, the private one readable only by its owner, and prints nothing', () => {
  const dir = join(tmp(), 'keys');
  const r = run(['keygen', '--out', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(statSync(join(dir, 'private.key')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(dir, 'public.key'), 'utf8').trim(), /^[A-Za-z0-9+/]+=*$/);
});

test('seal takes the public key from a file or from SEAL_PUBLIC_KEY; open takes the private key from a file or OPEN_PRIVATE_KEY', () => {
  const keys = join(tmp(), 'keys');
  run(['keygen', '--out', keys]);
  const pub = readFileSync(join(keys, 'public.key'), 'utf8').trim();
  const priv = readFileSync(join(keys, 'private.key'), 'utf8').trim();
  const holder = tmp();

  const byFile = join(holder, 'f.sealed');
  assert.equal(run(['seal', '--dir', source(), '--out', byFile, '--key-file', join(keys, 'public.key'), '--aad', '5:0']).status, 0);
  const d1 = join(holder, 'd1');
  const o1 = run(['open', '--in', byFile, '--dir', d1, '--key-file', join(keys, 'private.key'), '--aad', '5:0']);
  assert.equal(o1.status, 0, o1.stderr);
  assert.equal(readFileSync(join(d1, 'a.txt'), 'utf8'), 'hello');

  const byEnv = join(holder, 'e.sealed');
  assert.equal(run(['seal', '--dir', source(), '--out', byEnv], { SEAL_PUBLIC_KEY: pub }).status, 0);
  const d2 = join(holder, 'd2');
  assert.equal(run(['open', '--in', byEnv, '--dir', d2], { OPEN_PRIVATE_KEY: priv }).status, 0);
  assert.equal(readFileSync(join(d2, 'a.txt'), 'utf8'), 'hello');
});

test('open refuses a wrong aad, a wrong key and a missing key, printing only fixed messages', () => {
  const keys = join(tmp(), 'keys');
  const other = join(tmp(), 'other');
  run(['keygen', '--out', keys]);
  run(['keygen', '--out', other]);
  const holder = tmp();
  const sealed = join(holder, 'f.sealed');
  run(['seal', '--dir', source(), '--out', sealed, '--key-file', join(keys, 'public.key'), '--aad', '5:0']);
  const priv = readFileSync(join(keys, 'private.key'), 'utf8').trim();
  const otherPriv = readFileSync(join(other, 'private.key'), 'utf8').trim();
  const wrongAad = run(['open', '--in', sealed, '--dir', join(holder, 'a'), '--aad', '5:1'], { OPEN_PRIVATE_KEY: priv });
  assert.equal(wrongAad.status, 1);
  assert.match(wrongAad.stderr, /^decryption failed/);
  const wrongKey = run(['open', '--in', sealed, '--dir', join(holder, 'b'), '--aad', '5:0'], { OPEN_PRIVATE_KEY: otherPriv });
  assert.equal(wrongKey.status, 1);
  assert.ok(!wrongKey.stderr.includes(otherPriv) && !wrongKey.stdout.includes(otherPriv));
  const noKey = run(['open', '--in', sealed, '--dir', join(holder, 'c')], { OPEN_PRIVATE_KEY: '' });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /private key/);
  const missingFile = run(['open', '--in', '/nonexistent/zzsecret.sealed', '--dir', join(holder, 'd')], { OPEN_PRIVATE_KEY: priv });
  assert.equal(missingFile.stderr, 'decryption failed\n');
});

test('links are refused unless --allow-links is given on both sides', () => {
  const keys = join(tmp(), 'keys');
  run(['keygen', '--out', keys]);
  const src = source();
  symlinkSync('a.txt', join(src, 'link'));
  const holder = tmp();
  const sealed = join(holder, 'l.sealed');
  const priv = join(keys, 'private.key');
  assert.equal(run(['seal', '--dir', src, '--out', sealed, '--key-file', join(keys, 'public.key')]).status, 1);
  assert.equal(run(['seal', '--dir', src, '--out', sealed, '--key-file', join(keys, 'public.key'), '--allow-links']).status, 0);
  const refused = join(holder, 'r');
  const r = run(['open', '--in', sealed, '--dir', refused, '--key-file', priv]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unsafe archive/);
  assert.deepEqual(readdirSync(refused), []);
  const allowed = join(holder, 'a');
  assert.equal(run(['open', '--in', sealed, '--dir', allowed, '--key-file', priv, '--allow-links']).status, 0);
  assert.ok(lstatSync(join(allowed, 'link')).isSymbolicLink());
});

test('tag prints the 24 hex name derived from SLOT_KEY, and never the key', () => {
  const env = { SLOT_KEY: 'a-long-enough-slot-secret-0001' };
  const a = run(['tag', '--run-id', '777', '--label', 'pub'], env);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^[0-9a-f]{24}\n$/);
  assert.equal(run(['tag', '--run-id', '777', '--label', 'pub'], env).stdout, a.stdout);
  assert.notEqual(run(['tag', '--run-id', '777', '--label', 'out'], env).stdout, a.stdout);
  const bad = run(['tag', '--run-id', '777', '--label', 'pub'], { SLOT_KEY: 'zzkey' });
  assert.equal(bad.status, 1);
  assert.ok(!/zzkey/.test(bad.stderr + bad.stdout));
});

test('proof prints a 64 hex HMAC and proof-check accepts exactly that, including the hash of a data file', () => {
  const env = { SLOT_KEY: 'a-long-enough-slot-secret-0001' };
  const dir = tmp();
  const data = join(dir, 'entry.json');
  writeFileSync(data, '{"a":1}');
  const args = ['--run-id', '777-1', '--slot', '0', '--label', 'bundle'];
  const p = run(['proof', ...args, '--data-file', data], env);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^[0-9a-f]{64}\n$/);
  const proofFile = join(dir, 'p');
  writeFileSync(proofFile, p.stdout);
  const check = (extra, e = env) => run(['proof-check', ...extra, '--proof-file', proofFile], e).status;
  assert.equal(check([...args, '--data-file', data]), 0);
  assert.equal(check(['--run-id', '777-2', '--slot', '0', '--label', 'bundle', '--data-file', data]), 1, 'another attempt');
  assert.equal(check(['--run-id', '777-1', '--slot', '1', '--label', 'bundle', '--data-file', data]), 1, 'another slot');
  assert.equal(check([...args]), 1, 'without the data');
  writeFileSync(data, '{"a":2}');
  assert.equal(check([...args, '--data-file', data]), 1, 'changed data');
  assert.equal(check([...args, '--data-file', data], { SLOT_KEY: 'another-long-enough-secret-0002' }), 1, 'another secret');
  const bad = run(['proof-check', ...args, '--proof-file', proofFile], { SLOT_KEY: 'zzkey' });
  assert.equal(bad.status, 1);
  assert.ok(!/zzkey/.test(bad.stdout + bad.stderr));
});
