import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderReviewRound, renderReviewSummary, reviewLine, renderPrBody, renderTargetPr } from '../harness/lib/format.mjs';

const CLI = new URL('../harness/cli.mjs', import.meta.url).pathname;
const f = (id, severity, extra = {}) => ({ id, severity, file: 'src/x.ts', line: 42, rule: 'plan-mismatch', problem: `Problem ${id}.`, fix: '', ...extra });
const ok = { ok: true, exitCode: 0, timedOut: false, durationSec: 1 };

const round1 = {
  n: 1,
  findings: [f('R1', 'high'), f('R2', 'medium', { rule: 'missing-test', line: null }), f('R3', 'low', { rule: 'style' })],
  fixes: [{ id: 'R1', result: 'FIXED' }, { id: 'R2', result: 'WONTFIX', reason: 'plan task 3 | requires it' }],
  commit: 'abc1234def', checks: { test: ok, lint: ok }, reverted: false, durationSec: 300,
};
const review = { model: 'sonnet', exit: 'no-progress', rounds: [round1, { n: 2, findings: [f('R1', 'medium', { rule: 'missing-test', line: null })] }], open: [f('R1', 'medium', { rule: 'missing-test', line: null })] };

test('a round comment lists high and medium findings, results, checks and low findings', () => {
  const text = renderReviewRound(round1);
  assert.ok(text.startsWith('<!-- agent-review round=1 -->\n### Review round 1 — 1 high, 1 medium, 1 low'));
  assert.match(text, /\| R1 \| high \| `src\/x\.ts:42` \| plan-mismatch \| Problem R1\. \| FIXED \(abc1234\) \|/);
  assert.match(text, /\| R2 \| medium \| `src\/x\.ts` \| missing-test \| Problem R2\. \| WONTFIX: plan task 3 \\\| requires it \|/);
  assert.match(text, /Checks after fix: ✅ test ✅ lint/);
  assert.match(text, /<details><summary>1 low \(not fixed\)<\/summary>/);
  assert.doesNotMatch(text, /\| R3 \|/);
});

test('a reverted round says so and shows failing check output', () => {
  const text = renderReviewRound({ ...round1, reverted: true, checks: { test: { ok: false, exitCode: 1, timedOut: false, durationSec: 1, tail: 'boom' } } });
  assert.match(text, /\| R1 \| high .* \| REVERTED \|/);
  assert.match(text, /\*\*Reverted:\*\*/);
  assert.match(text, /\*\*test\*\* output \(last lines\)\n~~~\nboom\n~~~/);
});

test('a round with no high or medium findings', () => {
  assert.match(renderReviewRound({ n: 2, findings: [] }), /### Review round 2 — 0 high, 0 medium, 0 low\n\nNo high or medium findings\./);
});

test('a long round comment is cut below the limit', () => {
  const many = Array.from({ length: 400 }, (_, i) => f(`R${i + 1}`, 'high', { problem: 'p'.repeat(300) }));
  const text = renderReviewRound({ n: 1, findings: many });
  assert.ok(text.length < 60000);
  assert.ok(text.startsWith('<!-- agent-review round=1 -->'));
  assert.ok(text.endsWith('[truncated]'));
});

test('summary names the exit and the open findings', () => {
  const text = renderReviewSummary({ ...review, open: [{ ...f('R1', 'medium', { rule: 'missing-test', line: null }), result: 'WONTFIX', reason: 'no' }] });
  assert.ok(text.startsWith('<!-- agent-review summary -->\n### Review summary — no-progress'));
  assert.match(text, /Stopped: the same findings came back\. Rounds: 2\. Model: `sonnet`\./);
  assert.match(text, /\*\*Open findings \(1\)\*\*/);
  assert.match(text, /- R1 medium `src\/x\.ts` missing-test: Problem R1\. \(WONTFIX: no\)/);
  assert.match(renderReviewSummary({ ...review, exit: 'clean', open: [] }), /No open findings\./);
  assert.match(renderReviewSummary({ ...review, exit: 'reviewer-error', error: 'no ```json block in the review' }), /Error: no ```json block in the review/);
});

test('review line for target PR templates', () => {
  assert.equal(reviewLine(null), '');
  assert.equal(reviewLine({ ...review, open: [] }), 'Review: no open findings (2 rounds).');
  assert.equal(reviewLine(review), 'Review: 1 open finding — medium `src/x.ts` missing-test');
});

test('consumer PR body gets a Review section only with a review', () => {
  const v = {
    issue: 7, plan: 'docs/p.md', task: 1, taskTitle: 'Add greeting', baseBranch: 'main', model: 'sonnet', commits: 2,
    checks: { test: ok }, warnings: [], report: { summary: 'S', selfReview: 'R', knownIssues: 'None' }, reportText: 'x',
  };
  assert.doesNotMatch(renderPrBody(v), /## Review\n/);
  const body = renderPrBody({ ...v, review });
  assert.match(body, /## Review\nStopped: the same findings came back\. Rounds: 2\.\nOpen findings:\n- R1 medium `src\/x\.ts` missing-test: Problem R1\./);
});

test('{review} in a target PR template', () => {
  const base = { titleTemplate: 'T', issue: 7, task: 1, taskTitle: 'feat: x', report: { summary: 'S' }, checks: {}, changedFiles: [] };
  assert.equal(renderTargetPr({ ...base, bodyTemplate: '{summary}\n{review}', review }).prBody, 'S\nReview: 1 open finding — medium `src/x.ts` missing-test');
  assert.equal(renderTargetPr({ ...base, bodyTemplate: '{summary}|{review}' }).prBody, 'S|');
});

test('cli writes one file per round and a summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-cli-'));
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ outcome: 'READY_FOR_QA', review }));
  execFileSync('node', [CLI, 'render-review-comments', '--verdict', join(dir, 'verdict.json'), '--out', join(dir, 'out')]);
  assert.deepEqual(readdirSync(join(dir, 'out')).sort(), ['round-01.md', 'round-02.md', 'summary.md']);
  assert.match(readFileSync(join(dir, 'out', 'round-02.md'), 'utf8'), /^<!-- agent-review round=2 -->/);

  writeFileSync(join(dir, 'plain.json'), JSON.stringify({ outcome: 'READY_FOR_QA' }));
  execFileSync('node', [CLI, 'render-review-comments', '--verdict', join(dir, 'plain.json'), '--out', join(dir, 'none')]);
  assert.throws(() => readdirSync(join(dir, 'none')));
});
