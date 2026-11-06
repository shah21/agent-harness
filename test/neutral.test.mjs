import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintNeutralNames, lintEnvExpressions } from '../harness/lib/neutral.mjs';

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

test('step env values that carry project data are flagged: GitHub prints them (C2)', () => {
  const y = [
    '        env:',
    '          INDEX: ${{ matrix.index }}',
    '          RUN_KEY: ${{ secrets.RUN_KEY }}',
    '          PATH_IN: ${{ inputs.projects_path }}',
    '          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
    '          DEFAULT_BRANCH: ${{ steps.entry.outputs.default }}',
    '          BASE: ${{ needs.select.outputs.base }}',
    '          WHO: ${{ matrix.repo }}',
    '          TITLE: ${{ github.event.issue.title }}',
    '    outputs:',
    '      count: ${{ steps.select.outputs.count }}',
  ].join('\n');
  assert.deepEqual(lintEnvExpressions(y).map((v) => [v.line, v.expression]), [
    [6, 'steps.entry.outputs.default'], [7, 'needs.select.outputs.base'], [8, 'matrix.repo'], [9, 'github.event.issue.title'],
  ]);
});

test('slot-keyed tags may name artifacts, but no other step output may', () => {
  const y = [
    '      - name: Upload',
    '        with:',
    '          name: pub-${{ steps.names.outputs.pub }}',
    '          name: bundle-${{ steps.names.outputs.bundle }}',
    '          name: out-${{ steps.names.outputs.out }}',
    '          name: x-${{ steps.names.outputs.repo }}',
    '          name: ${{ steps.entry.outputs.repo }}',
  ].join('\n');
  assert.deepEqual(lintNeutralNames(y).map((v) => v.line), [6, 7]);
});

test('the run attempt may appear in an artifact name', () => {
  assert.deepEqual(lintNeutralNames('          name: selection-${{ github.run_attempt }}'), []);
});
