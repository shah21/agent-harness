import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../harness/lib/report.mjs';

const READY = [
  'STATUS: READY_FOR_QA',
  'TASK: plan=docs/p.md task=1 issue=#7',
  'SUMMARY:',
  'Added greeting.',
  'CHANGED_FILES:',
  '- greeting.txt',
  '- `tests/greeting.test.sh`',
  'CHECKS:',
  '- test: PASS',
  '- lint: FAIL',
  'SELF_REVIEW:',
  'Scoped.',
  'KNOWN_ISSUES:',
  'None',
].join('\n');

const BLOCKED = [
  'STATUS: BLOCKED',
  'TASK: plan=docs/p.md task=1 issue=#7',
  'BLOCKER:',
  'No secret.',
  'EVIDENCE:',
  '$ echo $KEY',
  '(empty)',
  'REQUIRED_HUMAN_ACTION:',
  'Set KEY.',
].join('\n');

test('parses a ready report', () => {
  const r = parseReport(READY);
  assert.equal(r.ok, true);
  assert.equal(r.report.status, 'READY_FOR_QA');
  assert.equal(r.report.summary, 'Added greeting.');
  assert.deepEqual(r.report.changedFiles, ['greeting.txt', 'tests/greeting.test.sh']);
  assert.deepEqual(r.report.checks, { test: 'PASS', lint: 'FAIL' });
  assert.equal(r.report.knownIssues, 'None');
});

test('tolerates code fences and CRLF', () => {
  const r = parseReport('```\r\n' + READY.replace(/\n/g, '\r\n') + '\r\n```\r\n');
  assert.equal(r.ok, true);
  assert.equal(r.report.knownIssues, 'None');
});

test('parses a complete blocked report', () => {
  const r = parseReport(BLOCKED);
  assert.equal(r.ok, true);
  assert.equal(r.report.blocker, 'No secret.');
  assert.equal(r.report.evidence, '$ echo $KEY\n(empty)');
  assert.equal(r.report.requiredHumanAction, 'Set KEY.');
});

test('blocked report requires blocker fields', () => {
  const r = parseReport('STATUS: BLOCKED\nTASK: t\nBLOCKER:\nNo secret.\n');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['missing EVIDENCE', 'missing REQUIRED_HUMAN_ACTION']);
});

test('ready report requires its fields', () => {
  const r = parseReport('STATUS: READY_FOR_QA\nTASK: t\n');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['missing SUMMARY', 'missing CHANGED_FILES', 'missing CHECKS', 'missing SELF_REVIEW', 'missing KNOWN_ISSUES']);
});

test('rejects missing or unknown status', () => {
  assert.deepEqual(parseReport('hello').errors, ['missing STATUS', 'missing TASK']);
  assert.match(parseReport('STATUS: DONE\nTASK: t').errors[0], /STATUS must be READY_FOR_QA or BLOCKED/);
});

test('rejects unreadable CHECKS lines', () => {
  const r = parseReport(READY.replace('- lint: FAIL', '- lint: probably fine'));
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /unreadable CHECKS line/);
});

test('a repeated key inside a field is content, not a new field', () => {
  const r = parseReport(READY.replace('KNOWN_ISSUES:\nNone', 'KNOWN_ISSUES:\nSTATUS: flaky upstream'));
  assert.equal(r.ok, true);
  assert.equal(r.report.status, 'READY_FOR_QA');
  assert.equal(r.report.knownIssues, 'STATUS: flaky upstream');
});
