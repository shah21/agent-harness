import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAccounts } from '../harness/lib/probe.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'probe-'));

test('an account that answers is usable', async () => {
  const logsDir = dir();
  const r = await probeAccounts({
    tokens: ['t1'], model: 'sonnet', projectDir: logsDir, logsDir,
    env: { ...process.env, AGENT_PROBE_CMD: 'echo ok' },
  });
  assert.deepEqual(r, { usable: [{ token: 't1', account: 1 }], limited: 0 });
});

test('a usage-limited account is counted and not usable', async () => {
  const logsDir = dir();
  const r = await probeAccounts({
    tokens: ['t1'], model: 'sonnet', projectDir: logsDir, logsDir,
    env: { ...process.env, AGENT_PROBE_CMD: 'echo "Claude AI usage limit reached"; exit 1' },
  });
  assert.deepEqual(r, { usable: [], limited: 1 });
});

test('a failing account without a usage-limit message is neither usable nor limited', async () => {
  const logsDir = dir();
  const r = await probeAccounts({
    tokens: ['t1'], model: 'sonnet', projectDir: logsDir, logsDir,
    env: { ...process.env, AGENT_PROBE_CMD: 'echo boom; exit 1' },
  });
  assert.deepEqual(r, { usable: [], limited: 0 });
});
