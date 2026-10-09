import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LABELS } from '../harness/lib/bootstrap.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('bootstrap creates the debug labels', () => {
  assert.ok(LABELS.includes('debug'));
  assert.ok(LABELS.includes('agent:debug-done'));
});

test('the debug issue template shows the optional lines', () => {
  const t = read('templates/debug-task.md');
  assert.match(t, /^---\nname: Debug task\n/);
  assert.match(t, /^ref: /m);
  assert.match(t, /^context: /m);
});

test('the README documents debug runs', () => {
  const r = read('README.md');
  assert.match(r, /^## Debug runs$/m);
  for (const s of ['`debug` label', '`ref:`', '`context:`', 'read-only', '"debug"', 'agent:debug-done', 'TARGET_READ_TOKEN']) {
    assert.ok(r.includes(s), s);
  }
});
