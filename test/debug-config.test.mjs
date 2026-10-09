import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../harness/lib/config.mjs';

const base = { install: 'x', checks: { t: 'y' } };
const load = (debug) => loadConfig(JSON.stringify({ ...base, ...(debug === undefined ? {} : { debug }) }));

test('debug defaults', () => {
  assert.deepEqual(load().debug, { contextPaths: [], timeout: 1800, maxTurns: 60 });
});

test('debug accepts overrides', () => {
  const c = load({ contextPaths: ['.agents/context/**', 'target/docs/*.md'], timeout: '10m', maxTurns: 20 });
  assert.deepEqual(c.debug, { contextPaths: ['.agents/context/**', 'target/docs/*.md'], timeout: 600, maxTurns: 20 });
});

test('debug rejects bad values', () => {
  assert.throws(() => load([]), /"debug" must be an object/);
  assert.throws(() => load({ contextPaths: 'x' }), /"debug.contextPaths" must be an array of strings/);
  assert.throws(() => load({ contextPaths: ['/etc/*'] }), /debug context path "\/etc\/\*"/);
  assert.throws(() => load({ contextPaths: ['../x'] }), /debug context path "\.\.\/x"/);
  assert.throws(() => load({ timeout: '10' }), /invalid duration/);
  assert.throws(() => load({ maxTurns: 0 }), /"debug.maxTurns"/);
});
