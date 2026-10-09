import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDebugIssue, parseDebugReport } from '../harness/lib/debug.mjs';

test('issue: symptom only', () => {
  assert.deepEqual(parseDebugIssue('The export fails.\n'), { context: null, ref: null, symptom: 'The export fails.' });
});

test('issue: ref and context lines are extracted and removed from the symptom', () => {
  const r = parseDebugIssue('ref: v1.2.3\ncontext: context/notes.md\nThe export fails\nwith a 500.\n');
  assert.deepEqual(r, { context: 'context/notes.md', ref: 'v1.2.3', symptom: 'The export fails\nwith a 500.' });
});

test('issue: accepts branches and shas as refs', () => {
  assert.equal(parseDebugIssue('ref: release/v1.2\nbug').ref, 'release/v1.2');
  assert.equal(parseDebugIssue('ref: 0123abc\nbug').ref, '0123abc');
});

test('issue: rejects unsafe refs', () => {
  for (const ref of ['--upload-pack=x', '../x', 'a..b', 'x/', 'x.lock', '-x']) {
    assert.match(parseDebugIssue(`ref: ${ref}\nbug`).error, /ref is not allowed/, ref);
  }
});

test('issue: rejects an unsafe context path and an empty symptom', () => {
  assert.match(parseDebugIssue('context: /etc/passwd\nbug').error, /context path must be relative/);
  assert.match(parseDebugIssue('context: ../x.md\nbug').error, /context path must be relative/);
  assert.match(parseDebugIssue('ref: main\n').error, /no symptom/);
  assert.match(parseDebugIssue('').error, /no symptom/);
});

const report = (over = {}) => {
  const f = {
    STATUS: 'FINDINGS',
    PROBLEM: 'Export returns 500.',
    REPRODUCTION: 'NOT_REPRODUCED - needs a database',
    EVIDENCE: 'src/export.js:42 divides by zero',
    HYPOTHESES: '1. empty list divides by zero - CONFIRMED - read src/export.js:42\n2. timeout in the db layer - UNKNOWN - cannot reach the db',
    ROOT_CAUSE: 'export divides by the row count without a guard',
    OWNING_MODULE: 'src/export.js',
    NEXT_ACTION: 'Guard the empty case.',
    UNKNOWNS: 'None',
    HUMAN_INPUT_NEEDED: 'None',
    ...over,
  };
  return Object.entries(f).map(([k, v]) => (v === null ? '' : `${k}:\n${v}`)).filter(Boolean).join('\n');
};

test('report: a complete FINDINGS report parses', () => {
  const r = parseDebugReport(report());
  assert.equal(r.ok, true);
  assert.equal(r.report.status, 'FINDINGS');
  assert.equal(r.report.rootCause, 'export divides by the row count without a guard');
  assert.deepEqual(r.report.hypotheses.map((h) => h.tag), ['CONFIRMED', 'UNKNOWN']);
  assert.deepEqual(r.warnings, []);
});

test('report: FINDINGS without a confirmed hypothesis is downgraded', () => {
  const r = parseDebugReport(report({ HYPOTHESES: '1. maybe the guard - INFERENCE - looks likely' }));
  assert.equal(r.report.status, 'INCONCLUSIVE');
  assert.match(r.warnings[0], /FINDINGS downgraded to INCONCLUSIVE/);
});

test('report: FINDINGS with ROOT_CAUSE None is downgraded', () => {
  const r = parseDebugReport(report({ ROOT_CAUSE: 'None' }));
  assert.equal(r.report.status, 'INCONCLUSIVE');
});

test('report: INCONCLUSIVE needs no confirmed hypothesis', () => {
  const r = parseDebugReport(report({ STATUS: 'INCONCLUSIVE', ROOT_CAUSE: 'None', HYPOTHESES: '1. guess - UNKNOWN - no data' }));
  assert.equal(r.ok, true);
  assert.equal(r.report.status, 'INCONCLUSIVE');
  assert.deepEqual(r.warnings, []);
});

test('report: BLOCKED needs only problem, evidence and human input', () => {
  const text = 'STATUS: BLOCKED\nPROBLEM:\nx\nEVIDENCE:\ny\nHUMAN_INPUT_NEEDED:\nneed the log';
  const r = parseDebugReport(text);
  assert.equal(r.ok, true);
  assert.equal(r.report.status, 'BLOCKED');
  assert.equal(r.report.humanInput, 'need the log');
});

test('report: errors are readable', () => {
  assert.deepEqual(parseDebugReport('').errors, ['missing STATUS']);
  assert.match(parseDebugReport('STATUS: DONE').errors[0], /STATUS must be FINDINGS, INCONCLUSIVE or BLOCKED, got "DONE"/);
  assert.deepEqual(parseDebugReport(report({ EVIDENCE: null, NEXT_ACTION: null })).errors, ['missing EVIDENCE', 'missing NEXT_ACTION']);
});

test('report: a later field name inside a value does not split the field', () => {
  const r = parseDebugReport(report({ EVIDENCE: 'line one\nPROBLEM: appears in the log' }));
  assert.equal(r.report.evidence, 'line one\nPROBLEM: appears in the log');
});
