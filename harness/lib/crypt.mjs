// Encrypts a directory for upload to a place strangers can read. tar | AES-256-GCM with a
// key derived from a shared secret. The auth tag is the last 16 bytes and is checked before
// anything is unpacked, so a damaged or forged file extracts nothing.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  appendFileSync, closeSync, createReadStream, createWriteStream, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const MAGIC = Buffer.from('AHE1');
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEADER = MAGIC.length + SALT + IV;

const key = (secret, salt) => scryptSync(secret, salt, 32);

function requireSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('encryption key missing or too short (16+ characters)');
}

function assertNoSymlinks(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error('refusing to archive a symbolic link');
    if (st.isDirectory()) assertNoSymlinks(p);
  }
}

const exited = (child, message) => new Promise((resolveP, reject) => {
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolveP() : reject(new Error(message))));
});

export async function encryptDir(dir, outFile, secret) {
  requireSecret(secret);
  const root = resolve(dir);
  if (resolve(outFile).startsWith(root + sep)) throw new Error('the output file must not be inside the directory it archives');
  assertNoSymlinks(root);
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key(secret, salt), iv);
  writeFileSync(outFile, Buffer.concat([MAGIC, salt, iv]));
  const tar = spawn('tar', ['-cf', '-', '-C', root, '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await Promise.all([
    pipeline(tar.stdout, cipher, createWriteStream(outFile, { flags: 'a' })),
    exited(tar, 'archiving failed'),
  ]);
  appendFileSync(outFile, cipher.getAuthTag());
}

export async function decryptToDir(inFile, dir, secret) {
  requireSecret(secret);
  const size = statSync(inFile).size;
  if (size <= HEADER + TAG) throw new Error('not an encrypted run file');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  const fd = openSync(inFile, 'r');
  try {
    readSync(fd, head, 0, HEADER, 0);
    readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    closeSync(fd);
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted run file');
  const decipher = createDecipheriv('aes-256-gcm', key(secret, head.subarray(MAGIC.length, MAGIC.length + SALT)), head.subarray(MAGIC.length + SALT));
  decipher.setAuthTag(tag);
  const scratch = mkdtempSync(join(tmpdir(), 'ahe-'));
  const archive = join(scratch, 'archive.tar');
  try {
    try {
      await pipeline(createReadStream(inFile, { start: HEADER, end: size - TAG - 1 }), decipher, createWriteStream(archive));
    } catch {
      throw new Error('decryption failed (wrong key or damaged file)');
    }
    mkdirSync(dir, { recursive: true });
    await exited(spawn('tar', ['-xf', archive, '-C', dir, '--no-same-owner'], { stdio: 'ignore' }), 'unpacking failed');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
