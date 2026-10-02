import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseDuration } from '../harness/lib/config.mjs';

const minimal = JSON.stringify({ install: 'pnpm install', checks: { test: 'pnpm test' } });

test('applies defaults', () => {
  const c = loadConfig(minimal);
  assert.equal(c.install, 'pnpm install');
  assert.deepEqual(c.checks, { test: 'pnpm test' });
  assert.equal(c.model, 'sonnet');
  assert.equal(c.maxTurns, 150);
  assert.deepEqual(c.timeouts, { install: 900, claude: 2700, check: 600 });
  assert.deepEqual(c.protectedPaths, ['.github/**', 'agent.config.json']);
  assert.deepEqual(c.testGlobs, ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'e2e/**']);
});

test('always protects .github and the config file', () => {
  const c = loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, protectedPaths: ['infra/**'] }));
  assert.deepEqual(c.protectedPaths, ['.github/**', 'agent.config.json', 'infra/**']);
});

test('partial timeouts merge with defaults', () => {
  const c = loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, timeouts: { claude: '20m' } }));
  assert.deepEqual(c.timeouts, { install: 900, claude: 1200, check: 600 });
});

test('parseDuration', () => {
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('1h'), 3600);
  assert.throws(() => parseDuration('10'), /invalid duration/);
  assert.throws(() => parseDuration('0m'), /invalid duration/);
  assert.throws(() => parseDuration('abc'), /invalid duration/);
});

test('rejects bad configs with a readable message', () => {
  assert.throws(() => loadConfig('{'), /not valid JSON/);
  assert.throws(() => loadConfig('[]'), /JSON object/);
  assert.throws(() => loadConfig(JSON.stringify({ checks: { t: 'x' } })), /"install"/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: {} })), /"checks"/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: { 'Bad Name': 'x' } })), /check name/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: { t: '' } })), /check "t"/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: { t: 'x' }, maxTurns: 0 })), /maxTurns/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: { t: 'x' }, testGlobs: 'x' })), /testGlobs/);
});
