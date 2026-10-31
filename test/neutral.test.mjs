import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintNeutralNames } from '../harness/lib/neutral.mjs';

test('index-only expressions in names and groups pass', () => {
  const y = [
    'run-name: run',
    'jobs:',
    '  run:',
    '    name: run (${{ matrix.index }})',
    '    concurrency:',
    '      group: selection',
    '    steps:',
    '      - name: Upload',
    '        with:',
    '          name: output-${{ matrix.index }}',
    '      - name: Round ${{ github.run_number }}',
  ].join('\n');
  assert.deepEqual(lintNeutralNames(y), []);
});

test('anything that can carry project text is flagged with its line', () => {
  const y = [
    'name: run ${{ github.repository }}',
    'jobs:',
    '  a:',
    '    name: ${{ needs.select.outputs.repo }}',
    '    concurrency:',
    '      group: ${{ github.event.issue.title }}',
    '      cancel-in-progress: false',
    '    steps:',
    '      - name: ${{ matrix.repo }}',
  ].join('\n');
  assert.deepEqual(lintNeutralNames(y).map((v) => [v.line, v.expression]), [
    [1, 'github.repository'], [4, 'needs.select.outputs.repo'], [6, 'github.event.issue.title'], [9, 'matrix.repo'],
  ]);
});

test('expressions outside name-like keys are not this lint\'s business', () => {
  assert.deepEqual(lintNeutralNames('env:\n  REPO: ${{ github.repository }}\nrun: echo ${{ github.repository }}'), []);
});
