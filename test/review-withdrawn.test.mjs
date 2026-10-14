import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReviewRound } from '../harness/lib/format.mjs';

const README = new URL('../README.md', import.meta.url).pathname;
const f = (id, severity, extra = {}) => ({ id, severity, file: 'src/x.ts', line: 4, rule: 'plan-mismatch', problem: `Problem ${id}.`, fix: '', ...extra });

test('withdrawn findings are listed with their evidence, outside the table', () => {
  const text = renderReviewRound({
    n: 1,
    findings: [f('R1', 'high', { verification: 'WITHDRAWN', evidence: 'x is never null here' }), f('R2', 'medium', { verification: 'CONFIRMED' })],
    fixes: [{ id: 'R2', result: 'FIXED' }], commit: 'abc1234', checks: {}, reverted: false,
  });
  assert.match(text, /\| R2 \| medium \|/);
  assert.doesNotMatch(text, /\| R1 \|/);
  assert.match(text, /<details><summary>1 withdrawn by verification<\/summary>\n\n- R1 high `src\/x\.ts:4` plan-mismatch: Problem R1\. Evidence: x is never null here\n\n<\/details>/);
});

test('a round whose findings were all withdrawn says so', () => {
  const text = renderReviewRound({ n: 2, findings: [f('R1', 'high', { verification: 'WITHDRAWN', evidence: 'e' })] });
  assert.match(text, /No confirmed high or medium findings\./);
});

test('README documents the review skill and the verify pass', () => {
  const readme = readFileSync(README, 'utf8');
  for (const word of ['"skill"', 'SKILL.md', 'review-skill/', 'WITHDRAWN', 'CONFIRMED', 'opus', 'changed hunk', '"review"', 'maxRounds', 'agent:review-open', 'AGENTS.md', '{review}']) {
    assert.ok(readme.includes(word), word);
  }
});
