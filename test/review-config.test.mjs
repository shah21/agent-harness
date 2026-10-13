import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../harness/lib/config.mjs';

const base = { install: 'x', checks: { t: 'y' } };
const load = (review) => loadConfig(JSON.stringify(review === undefined ? base : { ...base, review }));

test('no review block → review is null', () => {
  assert.equal(load().review, null);
});

test('an empty review block takes the defaults', () => {
  assert.deepEqual(load({}).review, { rules: [], model: 'sonnet', maxRounds: 2, timeout: 2400, maxTurns: 60 });
});

test('given values are kept', () => {
  const review = { rules: ['docs/review/*.md', 'target/AGENTS.md'], model: 'opus', maxRounds: 3, timeout: '1h', maxTurns: 30 };
  assert.deepEqual(load(review).review, { rules: ['docs/review/*.md', 'target/AGENTS.md'], model: 'opus', maxRounds: 3, timeout: 3600, maxTurns: 30 });
});

test('invalid values are rejected', () => {
  const cases = [
    [null, /"review" must be an object/],
    [[], /"review" must be an object/],
    ['x', /"review" must be an object/],
    [{ rules: 'a' }, /"review.rules" must be an array of strings/],
    [{ rules: [1] }, /"review.rules" must be an array of strings/],
    [{ rules: ['../x'] }, /review rule path "\.\.\/x" must be a relative path inside the repository/],
    [{ rules: ['/etc/x'] }, /review rule path "\/etc\/x" must be a relative path inside the repository/],
    [{ rules: [''] }, /review rule path "" must be a relative path inside the repository/],
    [{ model: '' }, /"review.model" must be a non-empty string/],
    [{ maxRounds: 0 }, /"review.maxRounds" must be an integer from 1 to 3/],
    [{ maxRounds: 4 }, /"review.maxRounds" must be an integer from 1 to 3/],
    [{ maxRounds: 1.5 }, /"review.maxRounds" must be an integer from 1 to 3/],
    [{ maxTurns: 0 }, /"review.maxTurns" must be a positive integer/],
    [{ timeout: '40' }, /invalid duration/],
  ];
  for (const [review, message] of cases) assert.throws(() => load(review), message, JSON.stringify(review));
});
