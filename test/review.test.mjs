import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEVERITIES, parseReviewOutput, actionable, fingerprint, parseFixReplies, withoutCommit, nextStep, openFindings, fitsBudget,
} from '../harness/lib/review.mjs';

const fence = (obj) => `Some words.\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
const f = (id, severity, file = 'a.txt', rule = 'plan-mismatch') => ({ id, severity, file, line: 3, rule, problem: `Problem ${id}.`, fix: `Fix ${id}.` });
const DIFF = ['a.txt', 'b.txt'];

test('severities are fixed', () => {
  assert.deepEqual(SEVERITIES, ['high', 'medium', 'low']);
});

test('parses findings', () => {
  const r = parseReviewOutput(fence({ status: 'FINDINGS', findings: [f('R1', 'high'), f('R2', 'low', 'elsewhere.txt', 'style')] }), DIFF);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'FINDINGS');
  assert.deepEqual(r.findings[0], f('R1', 'high'));
  assert.equal(r.findings[1].file, 'elsewhere.txt');
});

test('line and fix are optional', () => {
  const r = parseReviewOutput(fence({ status: 'FINDINGS', findings: [{ id: 'R1', severity: 'medium', file: 'a.txt', rule: 'missing-test', problem: 'No test.' }] }), DIFF);
  assert.deepEqual(r.findings[0], { id: 'R1', severity: 'medium', file: 'a.txt', line: null, rule: 'missing-test', problem: 'No test.', fix: '' });
});

test('CLEAN with no findings', () => {
  assert.deepEqual(parseReviewOutput(fence({ status: 'CLEAN', findings: [] }), DIFF), { ok: true, status: 'CLEAN', findings: [] });
});

test('CLEAN with a high finding is rejected', () => {
  const r = parseReviewOutput(fence({ status: 'CLEAN', findings: [f('R1', 'high')] }), DIFF);
  assert.deepEqual(r, { ok: false, error: 'status is CLEAN but high or medium findings are listed' });
});

test('invalid output is rejected with a reason', () => {
  const cases = [
    [null, /no ```json block/],
    ['all good', /no ```json block/],
    ['```json\n{oops\n```', /review JSON is invalid/],
    [fence([]), /review JSON must be an object/],
    [fence({ status: 'OK' }), /"status" must be CLEAN or FINDINGS/],
    [fence({ status: 'FINDINGS', findings: {} }), /"findings" must be an array/],
    [fence({ status: 'FINDINGS', findings: [{ ...f('X1', 'high') }] }), /finding 1: "id" must look like R1/],
    [fence({ status: 'FINDINGS', findings: [f('R1', 'high'), f('R1', 'low')] }), /finding 2: duplicate id R1/],
    [fence({ status: 'FINDINGS', findings: [f('R1', 'critical')] }), /R1: "severity" must be high, medium or low/],
    [fence({ status: 'FINDINGS', findings: [{ ...f('R1', 'high'), file: '' }] }), /R1: "file" must be a non-empty string/],
    [fence({ status: 'FINDINGS', findings: [{ ...f('R1', 'high'), line: 0 }] }), /R1: "line" must be a positive integer/],
    [fence({ status: 'FINDINGS', findings: [{ ...f('R1', 'high'), rule: 'Plan Mismatch' }] }), /R1: "rule" must be a kebab-case slug/],
    [fence({ status: 'FINDINGS', findings: [{ ...f('R1', 'high'), problem: ' ' }] }), /R1: "problem" must be a non-empty string/],
    [fence({ status: 'FINDINGS', findings: [{ ...f('R1', 'high'), fix: 3 }] }), /R1: "fix" must be a string/],
    [fence({ status: 'FINDINGS', findings: [f('R1', 'medium', 'other.txt')] }), /R1: "other.txt" is not in the diff/],
  ];
  for (const [text, message] of cases) {
    const r = parseReviewOutput(text, DIFF);
    assert.equal(r.ok, false, String(text));
    assert.match(r.error, message);
  }
});

test('actionable keeps high and medium; fingerprint ignores the line', () => {
  assert.deepEqual(actionable([f('R1', 'high'), f('R2', 'low'), f('R3', 'medium')]).map((x) => x.id), ['R1', 'R3']);
  assert.equal(fingerprint({ ...f('R1', 'high'), line: 99 }), fingerprint(f('R7', 'medium')));
  assert.equal(fingerprint(f('R1', 'high')), 'a.txt#plan-mismatch');
});

test('fixer replies, in id order, missing ones unaddressed', () => {
  const text = 'Done.\nR2: WONTFIX: the plan asks for this shape\nR1: FIXED\nR1: WONTFIX: second line ignored\nR9: FIXED\n';
  assert.deepEqual(parseFixReplies(text, ['R1', 'R2', 'R3']), [
    { id: 'R1', result: 'FIXED' },
    { id: 'R2', result: 'WONTFIX', reason: 'the plan asks for this shape' },
    { id: 'R3', result: 'UNADDRESSED' },
  ]);
  assert.deepEqual(parseFixReplies('R1: WONTFIX', ['R1']), [{ id: 'R1', result: 'WONTFIX', reason: 'no reason given' }]);
  assert.deepEqual(parseFixReplies(null, ['R1']), [{ id: 'R1', result: 'UNADDRESSED' }]);
});

test('without a commit, FIXED claims are unaddressed', () => {
  assert.deepEqual(withoutCommit([{ id: 'R1', result: 'FIXED' }, { id: 'R2', result: 'WONTFIX', reason: 'x' }]), [
    { id: 'R1', result: 'UNADDRESSED' },
    { id: 'R2', result: 'WONTFIX', reason: 'x' },
  ]);
});

test('next step', () => {
  const low = [f('R1', 'low')];
  assert.equal(nextStep({ round: 1, maxRounds: 2, findings: [], previous: null }), 'clean');
  assert.equal(nextStep({ round: 1, maxRounds: 2, findings: low, previous: null }), 'clean');
  assert.equal(nextStep({ round: 1, maxRounds: 2, findings: [f('R1', 'high')], previous: null }), 'fix');
  assert.equal(nextStep({ round: 1, maxRounds: 1, findings: [f('R1', 'high')], previous: null }), 'max-rounds');
  assert.equal(nextStep({ round: 2, maxRounds: 3, findings: [f('R1', 'high')], previous: [f('R4', 'medium')] }), 'no-progress');
  assert.equal(nextStep({ round: 2, maxRounds: 3, findings: [f('R1', 'high', 'b.txt')], previous: [f('R1', 'high')] }), 'fix');
  assert.equal(nextStep({ round: 2, maxRounds: 2, findings: [f('R1', 'high', 'b.txt')], previous: [f('R1', 'high')] }), 'max-rounds');
});

test('open findings', () => {
  assert.deepEqual(openFindings([]), []);
  assert.deepEqual(openFindings([{ n: 1, findings: [f('R1', 'low')] }]), []);
  assert.deepEqual(openFindings([{ n: 1, findings: [f('R1', 'high')] }]), [f('R1', 'high')]);
  assert.deepEqual(
    openFindings([{ n: 1, findings: [f('R1', 'high'), f('R2', 'medium'), f('R3', 'low')], fixes: [{ id: 'R1', result: 'FIXED' }, { id: 'R2', result: 'WONTFIX', reason: 'no' }] }]),
    [{ ...f('R1', 'high'), result: 'FIXED' }, { ...f('R2', 'medium'), result: 'WONTFIX', reason: 'no' }],
  );
  assert.deepEqual(
    openFindings([{ n: 1, findings: [f('R1', 'high')], fixes: [{ id: 'R1', result: 'FIXED' }], reverted: true }]),
    [{ ...f('R1', 'high'), result: 'REVERTED' }],
  );
});

test('budget: the next step must fit in what is left', () => {
  assert.equal(fitsBudget({ elapsedSec: 0, budgetSec: 100, longestStepSec: 0 }), true);
  assert.equal(fitsBudget({ elapsedSec: 60, budgetSec: 100, longestStepSec: 30 }), true);
  assert.equal(fitsBudget({ elapsedSec: 70, budgetSec: 100, longestStepSec: 30 }), false);
  assert.equal(fitsBudget({ elapsedSec: 100, budgetSec: 100, longestStepSec: 0 }), false);
});
