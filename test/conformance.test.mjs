import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanTask, comparePlan, conformanceWarnings } from '../harness/lib/conformance.mjs';

const FENCE = '```';
const PLAN = [
  '# Plan', '',
  '## Task 1: First', '',
  '**Files:**',
  '- Create: `src/a.ts`, `src/b.ts`',
  '- Modify: `src/c.ts:10-20`',
  '- Delete: `src/old.ts`',
  '- Test: `test/a.test.ts`', '',
  '- [ ] **Step 1: Write**', '',
  'Create `src/a.ts`:', '',
  `${FENCE}ts`, 'export const a = 1;', FENCE, '',
  'Create `src/b.ts`:', '',
  `${FENCE}ts`, 'export const b = 2;', FENCE, '',
  'Replace `README.md` with:', '',
  `${FENCE}markdown`, '# Title', FENCE, '',
  '## Task 2: Second', '',
  '**Files:**',
  '- Create: `src/z.ts`', '',
].join('\n');

const files = {
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 999;\n',
  'src/c.ts': 'changed\n',
  'test/a.test.ts': 'x\n',
};
const read = (p) => (p in files ? files[p] : null);

test('parsePlanTask reads the Files list and the code blocks of one task only', () => {
  const t = parsePlanTask(PLAN, 1);
  assert.deepEqual(t.files, [
    { action: 'Create', path: 'src/a.ts' },
    { action: 'Create', path: 'src/b.ts' },
    { action: 'Modify', path: 'src/c.ts' },
    { action: 'Delete', path: 'src/old.ts' },
    { action: 'Test', path: 'test/a.test.ts' },
  ]);
  assert.deepEqual([...t.blocks.keys()], ['src/a.ts', 'src/b.ts', 'README.md']);
  assert.equal(t.blocks.get('src/a.ts'), 'export const a = 1;');
  assert.deepEqual(parsePlanTask(PLAN, 2).files, [{ action: 'Create', path: 'src/z.ts' }]);
});

test('parsePlanTask copes with CRLF and returns null for an unknown task', () => {
  assert.equal(parsePlanTask(PLAN.replace(/\n/g, '\r\n'), 1).files.length, 5);
  assert.equal(parsePlanTask(PLAN, 9), null);
});

test('comparePlan reports identical, differing, missing and unexpected files', () => {
  const t = parsePlanTask(PLAN, 1);
  const diff = [
    { status: 'A', path: 'src/a.ts' },
    { status: 'A', path: 'src/b.ts' },
    { status: 'M', path: 'src/c.ts' },
    { status: 'A', path: 'test/a.test.ts' },
    { status: 'A', path: 'src/extra.ts' },
  ];
  const c = comparePlan(t, diff, read);
  assert.deepEqual(c.identical, ['src/a.ts']);
  assert.deepEqual(c.differs, ['src/b.ts']);
  assert.deepEqual(c.missing, ['src/old.ts']);
  assert.deepEqual(c.unexpected, ['src/extra.ts']);
  assert.equal(c.planned, 5);
  assert.equal(c.touchedPlanned, 4);
  assert.equal(c.checked, 2);
});

test('a planned delete counts as done when the file was removed, and renames cover both paths', () => {
  const t = parsePlanTask(PLAN, 1);
  const diff = [
    { status: 'D', path: 'src/old.ts' },
    { status: 'R', oldPath: 'src/c.ts', path: 'src/c2.ts' },
  ];
  const c = comparePlan(t, diff, read);
  assert.ok(!c.missing.includes('src/old.ts'));
  assert.ok(!c.missing.includes('src/c.ts'), 'the renamed-away path was touched');
  assert.deepEqual(c.unexpected, ['src/c2.ts']);
});

test('lockfiles and manifests are never reported as unexpected', () => {
  const t = parsePlanTask(PLAN, 1);
  const c = comparePlan(t, [{ status: 'M', path: 'package.json' }, { status: 'M', path: 'pnpm-lock.yaml' }], read);
  assert.deepEqual(c.unexpected, []);
});

test('a plan task without a Files list is skipped', () => {
  assert.equal(comparePlan(parsePlanTask('## Task 1: X\n\nJust prose.\n', 1), [{ status: 'A', path: 'a' }], read), null);
  assert.equal(comparePlan(null, [], read), null);
});

test('conformanceWarnings names each kind of mismatch and is silent when all matches', () => {
  assert.deepEqual(conformanceWarnings({ identical: ['a'], differs: [], missing: [], unexpected: [], planned: 1, touchedPlanned: 1, checked: 1 }), []);
  const w = conformanceWarnings({ identical: [], differs: ['b'], missing: ['m'], unexpected: ['u'], planned: 3, touchedPlanned: 2, checked: 1 });
  assert.equal(w.length, 3);
  assert.match(w.join('\n'), /differ from the plan's code: b/);
  assert.match(w.join('\n'), /planned files not changed: m/);
  assert.match(w.join('\n'), /not listed in the plan: u/);
});
