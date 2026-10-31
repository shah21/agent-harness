// Encrypts a directory for upload to a place strangers can read. tar | AES-256-GCM. The auth
// tag is the last 16 bytes and is checked before anything is unpacked, so a damaged or forged
// file extracts nothing.
//
// Two ways to get the key:
//   encryptDir / decryptToDir   a shared secret (scrypt). For jobs that all hold the secret.
//   sealDir / openSealed        the recipient's public key (X25519 + HKDF). The sender can seal
//                               but not open, which is what a job that runs untrusted code needs.
import {
  createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';
import {
  appendFileSync, closeSync, createReadStream, createWriteStream, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const SYM_MAGIC = Buffer.from('AHE1');
const SEAL_MAGIC = Buffer.from('AHS1');
const SALT = 16;
const IV = 12;
const TAG = 16;
const SPKI = 44; // an X25519 public key in SPKI DER
const SYM_HEADER = SYM_MAGIC.length + SALT + IV;
const SEAL_HEADER = SEAL_MAGIC.length + SPKI + IV;
const SEAL_INFO = 'agent-runner seal v1';

// Only these messages are safe to print where logs are public; anything else (an fs error
// carries a path) is replaced by a fixed message at the command line.
export class CryptError extends Error {}

const scryptKey = (secret, salt) => scryptSync(secret, salt, 32);

function requireSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) throw new CryptError('encryption key missing or too short (16+ characters)');
}

function assertNoSymlinks(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new CryptError('refusing to archive a symbolic link');
    if (st.isDirectory()) assertNoSymlinks(p);
  }
}

const exited = (child, message) => new Promise((resolveP, reject) => {
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolveP() : reject(new CryptError(message))));
});

// --- archive safety ----------------------------------------------------------------------

export function assertSafeNames(names) {
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').includes('..') || /[\0\r]/.test(name)) throw new CryptError('unsafe archive');
  }
}

// After extraction: no links of any kind and nothing but files and directories.
function assertNoLinks(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink > 1)) throw new CryptError('unsafe archive');
    if (st.isDirectory()) assertNoLinks(p);
  }
}

async function unpackSafely(archive, dir, allowLinks) {
  const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (listing.status !== 0) throw new CryptError('unpacking failed');
  assertSafeNames(listing.stdout.split('\n').filter(Boolean));
  mkdirSync(dir, { recursive: true });
  await exited(spawn('tar', ['-xf', archive, '-C', dir, '--no-same-owner', '--no-same-permissions'], { stdio: 'ignore' }), 'unpacking failed');
  if (!allowLinks) {
    try {
      assertNoLinks(dir);
    } catch (e) {
      for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
      throw e;
    }
  }
}

// --- the shared streaming core -------------------------------------------------------------

async function encryptWith({ dir, outFile, header, key, iv, aad, allowLinks }) {
  const root = resolve(dir);
  if (resolve(outFile).startsWith(root + sep)) throw new CryptError('the output file must not be inside the directory it archives');
  if (!allowLinks) assertNoSymlinks(root);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(String(aad)));
  writeFileSync(outFile, header);
  const tar = spawn('tar', ['-cf', '-', '-C', root, '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await Promise.all([
    pipeline(tar.stdout, cipher, createWriteStream(outFile, { flags: 'a' })),
    exited(tar, 'archiving failed'),
  ]);
  appendFileSync(outFile, cipher.getAuthTag());
}

function readHeaderAndTag(inFile, headerLen) {
  const size = statSync(inFile).size;
  if (size <= headerLen + TAG) throw new CryptError('not an encrypted run file');
  const head = Buffer.alloc(headerLen);
  const tag = Buffer.alloc(TAG);
  const fd = openSync(inFile, 'r');
  try {
    readSync(fd, head, 0, headerLen, 0);
    readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    closeSync(fd);
  }
  return { size, head, tag };
}

async function decryptWith({ inFile, dir, size, headerLen, key, iv, tag, aad, allowLinks }) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  if (aad !== undefined) decipher.setAAD(Buffer.from(String(aad)));
  const scratch = mkdtempSync(join(tmpdir(), 'ahe-'));
  const archive = join(scratch, 'archive.tar');
  try {
    try {
      await pipeline(createReadStream(inFile, { start: headerLen, end: size - TAG - 1 }), decipher, createWriteStream(archive));
    } catch {
      throw new CryptError('decryption failed (wrong key or damaged file)');
    }
    await unpackSafely(archive, dir, allowLinks);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- shared secret ---------------------------------------------------------------------------

// `aad` binds the file to its run and index, so a file cannot be swapped for another one.
export async function encryptDir(dir, outFile, secret, { aad, allowLinks = false } = {}) {
  requireSecret(secret);
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  await encryptWith({ dir, outFile, header: Buffer.concat([SYM_MAGIC, salt, iv]), key: scryptKey(secret, salt), iv, aad, allowLinks });
}

export async function decryptToDir(inFile, dir, secret, { aad, allowLinks = false } = {}) {
  requireSecret(secret);
  const { size, head, tag } = readHeaderAndTag(inFile, SYM_HEADER);
  if (!head.subarray(0, SYM_MAGIC.length).equals(SYM_MAGIC)) throw new CryptError('not an encrypted run file');
  const salt = head.subarray(SYM_MAGIC.length, SYM_MAGIC.length + SALT);
  const iv = head.subarray(SYM_MAGIC.length + SALT);
  await decryptWith({ inFile, dir, size, headerLen: SYM_HEADER, key: scryptKey(secret, salt), iv, tag, aad, allowLinks });
}

// --- public key ------------------------------------------------------------------------------

const b64 = (der) => der.toString('base64');
const BASE64 = /^[A-Za-z0-9+/]+=*$/;

export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: b64(privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

function publicKeyOf(text) {
  try {
    if (!BASE64.test(String(text).trim())) throw new Error('not base64');
    const der = Buffer.from(String(text).trim(), 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'x25519') throw new Error('wrong type');
    return { key, der: key.export({ type: 'spki', format: 'der' }) };
  } catch {
    throw new CryptError('invalid public key');
  }
}

function privateKeyOf(text) {
  try {
    if (!BASE64.test(String(text).trim())) throw new Error('not base64');
    const key = createPrivateKey({ key: Buffer.from(String(text).trim(), 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'x25519') throw new Error('wrong type');
    return key;
  } catch {
    throw new CryptError('invalid private key');
  }
}

const sealKey = (shared, ephDer, recipDer) => Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephDer, recipDer]), SEAL_INFO, 32));

// Seals a directory to a public key. The sender holds nothing that can open it again.
export async function sealDir(dir, outFile, publicKey, { aad, allowLinks = false } = {}) {
  const recipient = publicKeyOf(publicKey);
  const eph = generateKeyPairSync('x25519');
  const ephDer = eph.publicKey.export({ type: 'spki', format: 'der' });
  const key = sealKey(diffieHellman({ privateKey: eph.privateKey, publicKey: recipient.key }), ephDer, recipient.der);
  const iv = randomBytes(IV);
  await encryptWith({ dir, outFile, header: Buffer.concat([SEAL_MAGIC, ephDer, iv]), key, iv, aad, allowLinks });
}

export async function openSealed(inFile, dir, privateKey, { aad, allowLinks = false } = {}) {
  const priv = privateKeyOf(privateKey);
  const { size, head, tag } = readHeaderAndTag(inFile, SEAL_HEADER);
  if (!head.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) throw new CryptError('not an encrypted run file');
  const ephDer = head.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + SPKI);
  const iv = head.subarray(SEAL_MAGIC.length + SPKI);
  let key;
  try {
    const eph = createPublicKey({ key: ephDer, format: 'der', type: 'spki' });
    const recipDer = createPublicKey(priv).export({ type: 'spki', format: 'der' });
    key = sealKey(diffieHellman({ privateKey: priv, publicKey: eph }), ephDer, recipDer);
  } catch {
    throw new CryptError('decryption failed (wrong key or damaged file)');
  }
  await decryptWith({ inFile, dir, size, headerLen: SEAL_HEADER, key, iv, tag, aad, allowLinks });
}

// --- names that only a slot's own jobs can compute ----------------------------------------------

export function tagFor(secret, runId, label) {
  requireSecret(secret);
  if (!/^[A-Za-z0-9_.-]+$/.test(String(runId)) || !/^[a-z][a-z0-9-]*$/.test(String(label))) throw new CryptError('invalid tag input');
  return createHmac('sha256', secret).update(`${runId}:${label}`).digest('hex').slice(0, 24);
}

// --- proof that a handoff came from a holder of the slot key ------------------------------------
//
// An artifact name only protects a handoff until the artifact exists: any job of the run can
// delete an artifact and upload another under the same name. So the content proves its origin
// too: an HMAC under the slot key over the run and attempt, the slot, what it is and (when it
// applies) a hash of the data it vouches for. A job of another slot cannot compute it.

const PART = /^[A-Za-z0-9_.-]+$/;

export function proofFor(secret, ...parts) {
  requireSecret(secret);
  if (parts.length === 0 || parts.some((p) => !PART.test(String(p)))) throw new CryptError('invalid proof input');
  return createHmac('sha256', secret).update(parts.join('\n')).digest('hex');
}

export function verifyProof(secret, proof, ...parts) {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  let expected;
  try {
    expected = proofFor(secret, ...parts);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}
