import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../harness/lib/config.mjs';

const base = { install: 'x', checks: { t: 'y' } };
const load = (review) => loadConfig(JSON.stringify(review === undefined ? base : { ...base, review }));

test('no review block → review is null', () => {
  assert.equal(load().review, null);
});

test('a review block with only a skill takes the defaults', () => {
  assert.deepEqual(load({ skill: 'skill' }).review, { skill: 'skill', rules: [], model: 'opus', maxRounds: 2, timeout: 2400, maxTurns: 60 });
});

test('given values are kept', () => {
  const review = { skill: 'target/.agents/skills/review', rules: ['docs/review/*.md'], model: 'sonnet', maxRounds: 3, timeout: '1h', maxTurns: 30 };
  assert.deepEqual(load(review).review, { ...review, timeout: 3600 });
});

test('invalid values are rejected', () => {
  const skill = 'skill';
  const cases = [
    [null, /"review" must be an object/],
    [[], /"review" must be an object/],
    [{}, /"review.skill" must be a relative path inside the repository/],
    [{ skill: '' }, /"review.skill" must be a relative path inside the repository/],
    [{ skill: '/abs' }, /"review.skill" must be a relative path inside the repository/],
    [{ skill: '../up' }, /"review.skill" must be a relative path inside the repository/],
    [{ skill: 3 }, /"review.skill" must be a relative path inside the repository/],
    [{ skill, rules: 'a' }, /"review.rules" must be an array of strings/],
    [{ skill, rules: ['../x'] }, /review rule path "\.\.\/x" must be a relative path inside the repository/],
    [{ skill, model: '' }, /"review.model" must be a non-empty string/],
    [{ skill, maxRounds: 0 }, /"review.maxRounds" must be an integer from 1 to 3/],
    [{ skill, maxRounds: 4 }, /"review.maxRounds" must be an integer from 1 to 3/],
    [{ skill, maxTurns: 0 }, /"review.maxTurns" must be a positive integer/],
    [{ skill, timeout: '40' }, /invalid duration/],
  ];
  for (const [review, message] of cases) assert.throws(() => load(review), message, JSON.stringify(review));
});
