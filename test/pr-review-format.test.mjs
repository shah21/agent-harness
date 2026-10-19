import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderPrReview, mergeIssueBody, renderReviewBlocked } from '../harness/lib/pr-review-format.mjs';

const CLI = new URL('../harness/cli.mjs', import.meta.url).pathname;
const HEAD = 'a1b2c3d'.padEnd(40, '0');
const f = (id, severity, extra = {}) => ({ id, severity, file: 'target/src/app.ts', line: 42, rule: 'plan-mismatch', problem: `Problem ${id}.`, fix: `Fix ${id}.`, ...extra });
const verdict = (findings, review = 'changes', extra = {}) => ({
  mode: 'review', outcome: 'REVIEWED', model: 'opus', warnings: [],
  prs: [{ repo: 'o/super', number: 12, url: 'u', headSha: HEAD, baseSha: 'b', prefix: 'target/' }],
  review: { verdict: review, findings }, ...extra,
});

test('a review with findings', () => {
  const text = renderPrReview(verdict([
    f('R1', 'high', { verification: 'CONFIRMED' }),
    f('R2', 'medium', { verification: 'CONFIRMED', line: 7, file: 'target/lib/x.ts', fix: '' }),
    f('R3', 'low', { line: null }),
    f('R4', 'high', { verification: 'WITHDRAWN', evidence: 'never null' }),
  ]), { runUrl: 'https://run' });
  assert.equal(text, [
    '<!-- agent-pr-review -->',
    '## 🔴 Changes requested · 1 high · 1 medium',
    '`o/super#12` @ a1b2c3d',
    '',
    `- 🔴 [\`src/app.ts:42\`](https://github.com/o/super/blob/${HEAD}/src/app.ts#L42) Problem R1. **Fix:** Fix R1.`,
    `- 🟡 [\`lib/x.ts:7\`](https://github.com/o/super/blob/${HEAD}/lib/x.ts#L7) Problem R2.`,
    '',
    '<details><summary>1 low · 1 withdrawn</summary>',
    '',
    `- low [\`src/app.ts\`](https://github.com/o/super/blob/${HEAD}/src/app.ts) Problem R3.`,
    `- withdrawn [\`src/app.ts:42\`](https://github.com/o/super/blob/${HEAD}/src/app.ts#L42) Problem R4. Evidence: never null`,
    '',
    '</details>',
    '',
    '<sub>opus · [run](https://run)</sub>',
  ].join('\n'));
});

test('a clean review is one heading and the pull request line', () => {
  assert.equal(renderPrReview(verdict([], 'clean'), {}), '<!-- agent-pr-review -->\n## 🟢 Looks good\n`o/super#12` @ a1b2c3d\n\n<sub>opus</sub>');
});

test('long sentences are cut', () => {
  const text = renderPrReview(verdict([f('R1', 'medium', { verification: 'CONFIRMED', problem: 'p'.repeat(300) })], 'comments'), {});
  assert.match(text, /^## 🟡 Comments · 1 medium$/m);
  assert.match(text, new RegExp(`${'p'.repeat(159)}… \\*\\*Fix:\\*\\*`));
});

test('a second review replaces the first', () => {
  const first = mergeIssueBody('pr: o/super#12\nplease check', verdict([], 'clean'), {});
  assert.ok(first.startsWith('pr: o/super#12\nplease check\n\n<!-- agent-pr-review -->\n## 🟢 Looks good'));
  const second = mergeIssueBody(first, verdict([f('R1', 'high', { verification: 'CONFIRMED' })]), {});
  assert.equal(second.split('<!-- agent-pr-review -->').length, 2);
  assert.match(second, /Changes requested/);
  assert.doesNotMatch(second, /Looks good/);
});

test('an oversized review is cut to fit', () => {
  const lows = Array.from({ length: 2000 }, (_, i) => f(`R${i + 1}`, 'low', { problem: 'x'.repeat(150) }));
  const body = mergeIssueBody('pr: o/super#12', verdict([f('R9999', 'high', { verification: 'CONFIRMED' }), ...lows]), {});
  assert.ok(body.length <= 60000);
  assert.match(body, /<!-- agent-pr-review -->\n## 🔴 Changes requested/);
  assert.match(body, /\(cut\)<\/summary>/);
});

test('blocked comment and cli', () => {
  const v = { mode: 'review', outcome: 'BLOCKED', kind: 'harness', reasons: ['pull request checkout failed'] };
  assert.equal(renderReviewBlocked(v, { runUrl: 'https://run' }),
    '⛔ **BLOCKED** (harness)\n\n- pull request checkout failed\n\n[Run log and artifacts](https://run)\n\nTo retry: remove `agent:blocked` and add `review`.');
  const dir = mkdtempSync(join(tmpdir(), 'review-format-'));
  writeFileSync(join(dir, 'v.json'), JSON.stringify(verdict([], 'clean')));
  writeFileSync(join(dir, 'body.md'), 'pr: o/super#12\n');
  const out = execFileSync('node', [CLI, 'render-pr-review', '--verdict', join(dir, 'v.json'), '--body', join(dir, 'body.md'), '--run-url', 'https://run'], { encoding: 'utf8' });
  assert.ok(out.startsWith('pr: o/super#12\n\n<!-- agent-pr-review -->'));
});
