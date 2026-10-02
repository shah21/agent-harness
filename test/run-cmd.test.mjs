import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithTimeout } from '../harness/lib/run-cmd.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'runcmd-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('captures exit code and output', async () => {
  const dir = tempDir();
  const r = await runWithTimeout('echo hi; echo err >&2; exit 3', { cwd: dir, timeoutSec: 5, logFile: join(dir, 'out.log') });
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
  assert.match(readFileSync(join(dir, 'out.log'), 'utf8'), /hi\nerr/);
});

test('kills the whole process group on timeout', async () => {
  const dir = tempDir();
  const started = Date.now();
  const r = await runWithTimeout('sleep 30 & sleep 30', { cwd: dir, timeoutSec: 1, logFile: join(dir, 'out.log') });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000, 'returned promptly');
});

test('kills background children left behind after a normal exit', async () => {
  const dir = tempDir();
  const r = await runWithTimeout('sleep 30 & echo $! > pid', { cwd: dir, timeoutSec: 5, logFile: join(dir, 'out.log') });
  assert.equal(r.exitCode, 0);
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
  await sleep(300);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('accepts argv arrays and reports spawn failures as 127', async () => {
  const dir = tempDir();
  const ok = await runWithTimeout(['sh', '-c', 'exit 0'], { cwd: dir, timeoutSec: 5, logFile: join(dir, 'a.log') });
  assert.equal(ok.exitCode, 0);
  const missing = await runWithTimeout(['definitely-not-a-command-xyz'], { cwd: dir, timeoutSec: 5, logFile: join(dir, 'b.log') });
  assert.equal(missing.exitCode, 127);
});
