import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../harness/lib/gate.mjs';

const config = { protectedPaths: ['.github/**', 'agent.config.json'], testGlobs: ['tests/**'] };
const ready = ({ checks = '- test: PASS\n- lint: PASS', files = '- a.txt' } = {}) =>
  `STATUS: READY_FOR_QA\nTASK: t\nSUMMARY:\ns\nCHANGED_FILES:\n${files}\nCHECKS:\n${checks}\nSELF_REVIEW:\nok\nKNOWN_ISSUES:\nNone\n`;
const allOk = { test: { ok: true }, lint: { ok: true } };
const base = {
  agent: { exitCode: 0, timedOut: false },
  reportText: ready(),
  commits: 1,
  diff: [{ status: 'A', path: 'a.txt' }],
  checks: allOk,
  config,
};
const run = (over) => decide({ ...base, ...over });

test('1: agent timeout wins over everything else', () => {
  const d = run({ agent: { exitCode: 137, timedOut: true }, reportText: null });
  assert.equal(d.outcome, 'BLOCKED');
  assert.equal(d.kind, 'agent');
  assert.match(d.reasons[0], /timed out/);
});

test('1: agent non-zero exit', () => {
  const d = run({ agent: { exitCode: 1, timedOut: false } });
  assert.equal(d.kind, 'agent');
  assert.match(d.reasons[0], /exited with code 1/);
});

test('2: missing or malformed report', () => {
  assert.deepEqual(run({ reportText: null }).reasons, ['agent wrote no report']);
  assert.equal(run({ reportText: null }).kind, 'harness');
  const d = run({ reportText: 'hello' });
  assert.equal(d.kind, 'harness');
  assert.deepEqual(d.reasons, ['report: missing STATUS', 'report: missing TASK']);
});

test('3: agent reports BLOCKED', () => {
  const d = run({
    reportText: 'STATUS: BLOCKED\nTASK: t\nBLOCKER:\nNo secret.\nEVIDENCE:\nx\nREQUIRED_HUMAN_ACTION:\nSet it.',
    commits: 0,
  });
  assert.equal(d.outcome, 'BLOCKED');
  assert.equal(d.kind, 'report');
  assert.deepEqual(d.reasons, ['No secret.']);
  assert.equal(d.report.requiredHumanAction, 'Set it.');
});

test('4: ready with no commits', () => {
  const d = run({ commits: 0 });
  assert.equal(d.kind, 'gate');
  assert.match(d.reasons[0], /no commits/);
});

test('5: protected paths, including rename sources', () => {
  assert.match(run({ diff: [{ status: 'A', path: '.github/x.yml' }] }).reasons[0], /protected paths: \.github\/x\.yml/);
  const d = run({ diff: [{ status: 'R', oldPath: 'agent.config.json', path: 'x.json' }] });
  assert.match(d.reasons[0], /protected paths: agent\.config\.json/);
});

test('6: deleted or renamed existing tests', () => {
  assert.match(run({ diff: [{ status: 'D', path: 'tests/a.sh' }] }).reasons[0], /existing tests deleted or renamed: tests\/a\.sh/);
  assert.match(run({ diff: [{ status: 'R', oldPath: 'tests/b.sh', path: 'old/b.sh' }] }).reasons[0], /tests\/b\.sh/);
  assert.equal(run({ diff: [{ status: 'M', path: 'tests/a.sh' }], reportText: ready({ files: '- tests/a.sh' }) }).outcome, 'READY_FOR_QA');
});

test('7: real check failures, flagging false PASS claims', () => {
  const d = run({ checks: { test: { ok: false }, lint: { ok: true } } });
  assert.equal(d.kind, 'gate');
  assert.deepEqual(d.reasons, ['check "test" failed (report claimed PASS)']);
  const honest = run({ checks: { test: { ok: false }, lint: { ok: true } }, reportText: ready({ checks: '- test: FAIL\n- lint: PASS' }) });
  assert.deepEqual(honest.reasons, ['check "test" failed']);
});

test('8: ready with no warnings', () => {
  const d = run({});
  assert.equal(d.outcome, 'READY_FOR_QA');
  assert.equal(d.kind, null);
  assert.deepEqual(d.reasons, []);
  assert.deepEqual(d.warnings, []);
});

test('warnings: check status mismatch, changed files mismatch, dependency files', () => {
  assert.deepEqual(run({ reportText: ready({ checks: '- test: PASS\n- lint: NOT_RUN' }) }).warnings, [
    'report listed check "lint" as NOT_RUN, but it passed when the harness ran it',
  ]);
  assert.deepEqual(run({ reportText: ready({ files: '- b.txt' }) }).warnings, [
    'CHANGED_FILES does not match the diff (diff: a.txt)',
  ]);
  const deps = run({ diff: [{ status: 'M', path: 'package.json' }], reportText: ready({ files: '- package.json' }) });
  assert.deepEqual(deps.warnings, ['dependency files changed: package.json']);
});

test('submodule pointer errors block after protected paths', () => {
  const errors = ['submodule target/sub changed but the superproject does not point at it'];
  const d = run({ pointerErrors: errors });
  assert.equal(d.outcome, 'BLOCKED');
  assert.equal(d.kind, 'gate');
  assert.deepEqual(d.reasons, errors);
  const p = run({ pointerErrors: errors, diff: [{ status: 'M', path: '.github/workflows/x.yml' }] });
  assert.match(p.reasons[0], /protected paths/);
});

test('empty pointer errors change nothing', () => {
  assert.equal(run({ pointerErrors: [] }).outcome, 'READY_FOR_QA');
});
