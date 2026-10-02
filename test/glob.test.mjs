import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAny } from '../harness/lib/glob.mjs';

test('**/ matches any depth, including the root', () => {
  assert.ok(matchesAny('a.test.ts', ['**/*.test.ts']));
  assert.ok(matchesAny('src/lib/a.test.ts', ['**/*.test.ts']));
  assert.ok(!matchesAny('src/lib/a.test.tsx', ['**/*.test.ts']));
});

test('dir/** matches everything under dir only', () => {
  assert.ok(matchesAny('.github/workflows/ci.yml', ['.github/**']));
  assert.ok(!matchesAny('src/.github.ts', ['.github/**']));
});

test('single * does not cross directories', () => {
  assert.ok(matchesAny('src/a.ts', ['src/*.ts']));
  assert.ok(!matchesAny('src/x/a.ts', ['src/*.ts']));
});

test('dots are literal', () => {
  assert.ok(matchesAny('agent.config.json', ['agent.config.json']));
  assert.ok(!matchesAny('agentXconfigXjson', ['agent.config.json']));
});
