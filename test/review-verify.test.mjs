import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewOutput, actionable, parseVerifyReplies, applyVerification, nextStep, openFindings } from '../harness/lib/review.mjs';

const fence = (obj) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
const f = (id, severity, extra = {}) => ({ id, severity, file: 'a.txt', line: 2, rule: 'plan-mismatch', problem: `P ${id}.`, fix: '', ...extra });
const HUNKS = new Map([['a.txt', [[2, 3]]], ['b.txt', [[1, 1]]]]);
const DIFF = ['a.txt', 'b.txt'];

test('anchors must sit in a changed hunk', () => {
  assert.equal(parseReviewOutput(fence({ status: 'FINDINGS', findings: [f('R1', 'high')] }), DIFF, HUNKS).ok, true);
  assert.deepEqual(parseReviewOutput(fence({ status: 'FINDINGS', findings: [f('R1', 'high', { line: 9 })] }), DIFF, HUNKS),
    { ok: false, error: 'R1: line 9 of "a.txt" is not in a changed hunk' });
  assert.deepEqual(parseReviewOutput(fence({ status: 'FINDINGS', findings: [f('R1', 'medium', { line: null })] }), DIFF, HUNKS),
    { ok: false, error: 'R1: "line" is required for high and medium findings' });
  assert.equal(parseReviewOutput(fence({ status: 'FINDINGS', findings: [f('R1', 'low', { line: null, file: 'c.txt' })] }), DIFF, HUNKS).ok, true);
});

test('without hunks the old rules apply', () => {
  assert.equal(parseReviewOutput(fence({ status: 'FINDINGS', findings: [f('R1', 'high', { line: 9 })] }), DIFF).ok, true);
});

test('verifier replies, missing ones confirmed', () => {
  const replies = parseVerifyReplies('R2: WITHDRAWN: the branch cannot run, x is never null\nR1: CONFIRMED\nR9: WITHDRAWN: other\n', ['R1', 'R2', 'R3']);
  assert.deepEqual([...replies.entries()], [
    ['R1', { verification: 'CONFIRMED' }],
    ['R2', { verification: 'WITHDRAWN', evidence: 'the branch cannot run, x is never null' }],
    ['R3', { verification: 'CONFIRMED' }],
  ]);
  assert.deepEqual([...parseVerifyReplies(null, ['R1']).entries()], [['R1', { verification: 'CONFIRMED' }]]);
});

test('a withdrawal without evidence is kept', () => {
  assert.deepEqual(parseVerifyReplies('R1: WITHDRAWN\nR2: WITHDRAWN:   \n', ['R1', 'R2']).get('R2'), { verification: 'CONFIRMED' });
  assert.deepEqual(parseVerifyReplies('R1: WITHDRAWN\n', ['R1']).get('R1'), { verification: 'CONFIRMED' });
});

test('withdrawn findings stop counting', () => {
  const findings = applyVerification([f('R1', 'high'), f('R2', 'medium'), f('R3', 'low')], new Map([
    ['R1', { verification: 'WITHDRAWN', evidence: 'e' }],
    ['R2', { verification: 'CONFIRMED' }],
  ]));
  assert.deepEqual(findings[0], { ...f('R1', 'high'), verification: 'WITHDRAWN', evidence: 'e' });
  assert.equal(findings[2].verification, undefined);
  assert.deepEqual(actionable(findings).map((x) => x.id), ['R2']);
  const onlyWithdrawn = applyVerification([f('R1', 'high')], new Map([['R1', { verification: 'WITHDRAWN', evidence: 'e' }]]));
  assert.equal(nextStep({ round: 1, maxRounds: 2, findings: onlyWithdrawn, previous: null }), 'clean');
  assert.deepEqual(openFindings([{ n: 1, findings: onlyWithdrawn }]), []);
});
