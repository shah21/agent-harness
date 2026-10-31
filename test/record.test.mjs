import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, recordPath } from '../harness/lib/record.mjs';

const verdict = {
  outcome: 'BLOCKED', kind: 'checks', issue: 12, plan: 'docs/p.md', task: 3, model: 'sonnet', commits: 2,
  reasons: ['x'.repeat(500), 'second', 'third', 'fourth', 'fifth', 'sixth'],
  account: 'primary', reportText: 'SECRET REPORT', report: { a: 1 }, checks: { test: { code: 1, tail: 'LOG' } },
};
const entry = { index: 1, repo: 'alice/one', tokenKind: 'classic', tokenOwner: 'alice', tokenIndex: 1 };
const now = new Date('2026-10-31T12:00:00Z');

test('a record carries only the allow-listed fields', () => {
  const r = buildRecord({ verdict, entry, runId: '777', now });
  assert.deepEqual(Object.keys(r).sort(), ['commits', 'issue', 'kind', 'model', 'outcome', 'plan', 'reasons', 'repo', 'runner', 'task', 'tokenKind', 'ts', 'v']);
  assert.equal(r.repo, 'alice/one');
  assert.equal(r.tokenKind, 'classic');
  assert.deepEqual(r.runner, { run: '777', index: 1 });
  assert.equal(r.ts, '2026-10-31T12:00:00.000Z');
  const text = JSON.stringify(r);
  assert.ok(!/SECRET REPORT|primary|LOG/.test(text), 'no account, report or log text');
});

test('reasons are trimmed to five lines of 300 characters', () => {
  const r = buildRecord({ verdict, entry, runId: '1', now });
  assert.equal(r.reasons.length, 5);
  assert.equal(r.reasons[0].length, 300);
});

test('a verdict with missing fields still builds a record', () => {
  const r = buildRecord({ verdict: { outcome: 'READY_FOR_QA' }, entry, runId: '1', now });
  assert.equal(r.outcome, 'READY_FOR_QA');
  assert.equal(r.kind, null);
  assert.deepEqual(r.reasons, []);
});

test('the path is stable for a run and index, so a retry overwrites instead of duplicating', () => {
  const r = buildRecord({ verdict, entry, runId: '777', now });
  assert.equal(recordPath(r), 'runs/2026-10/777-1.json');
  assert.equal(recordPath(buildRecord({ verdict, entry, runId: '777', now: new Date('2026-10-31T23:59:00Z') })), 'runs/2026-10/777-1.json');
});
