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
  assert.deepEqual(c.timeouts, { install: 900, claude: 2700, check: 600, setup: 300 });
  assert.equal(c.setup, null);
  assert.deepEqual(c.artifacts, []);
  assert.deepEqual(c.protectedPaths, ['.github/**', 'agent.config.json']);
  assert.deepEqual(c.testGlobs, ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'e2e/**']);
});

test('always protects .github and the config file', () => {
  const c = loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, protectedPaths: ['infra/**'] }));
  assert.deepEqual(c.protectedPaths, ['.github/**', 'agent.config.json', 'infra/**']);
});

test('partial timeouts merge with defaults', () => {
  const c = loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, timeouts: { claude: '20m' } }));
  assert.deepEqual(c.timeouts, { install: 900, claude: 1200, check: 600, setup: 300 });
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

test('env defaults to empty and accepts plain string values', () => {
  assert.deepEqual(loadConfig(minimal).env, {});
  const c = loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, env: { DATABASE_URL: 'postgres://u:p@localhost/db' } }));
  assert.deepEqual(c.env, { DATABASE_URL: 'postgres://u:p@localhost/db' });
});

test('env rejects non-strings, bad names and credentials the harness owns', () => {
  const env = (e) => JSON.stringify({ install: 'x', checks: { t: 'y' }, env: e });
  assert.throws(() => loadConfig(env([])), /"env" must be an object/);
  assert.throws(() => loadConfig(env({ PORT: 3000 })), /env "PORT" must be a string/);
  assert.throws(() => loadConfig(env({ 'bad-name': 'x' })), /env name "bad-name"/);
  assert.throws(() => loadConfig(env({ CLAUDE_CODE_OAUTH_TOKEN: 'x' })), /reserved/);
  assert.throws(() => loadConfig(env({ GITHUB_TOKEN: 'x' })), /reserved/);
  assert.throws(() => loadConfig(env({ PATH: '/tmp' })), /reserved/);
});

test('accepts setup, artifacts and a setup timeout', () => {
  const c = loadConfig(JSON.stringify({
    install: 'x', checks: { t: 'y' },
    setup: 'docker compose up -d --wait',
    artifacts: ['playwright-report/**', 'test-results/**'],
    timeouts: { setup: '2m' },
  }));
  assert.equal(c.setup, 'docker compose up -d --wait');
  assert.deepEqual(c.artifacts, ['playwright-report/**', 'test-results/**']);
  assert.equal(c.timeouts.setup, 120);
});

test('rejects a bad setup command', () => {
  const base = { install: 'x', checks: { t: 'y' } };
  assert.throws(() => loadConfig(JSON.stringify({ ...base, setup: '' })), /"setup" must be a non-empty command string/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, setup: ['a'] })), /"setup" must be a non-empty command string/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, timeouts: { setup: '5' } })), /invalid duration/);
});

test('rejects artifact globs that are not relative paths inside the project', () => {
  const base = { install: 'x', checks: { t: 'y' } };
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: 'report/**' })), /"artifacts" must be an array of strings/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: ['/etc/**'] })), /artifact glob "\/etc\/\*\*" must be a relative path inside the project/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: ['../x/**'] })), /must be a relative path inside the project/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: ['a/../../x'] })), /must be a relative path inside the project/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: [''] })), /must be a relative path inside the project/);
});
