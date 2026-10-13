import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runTarget, AGENTS } from './helpers/target-fixture.mjs';

const REVIEW = { maxRounds: 2, timeout: '2m', maxTurns: 5 };
const withReview = (dir) => {
  const path = join(dir, 'agent.config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.review = REVIEW;
  writeFileSync(path, JSON.stringify(config, null, 2));
};
const sha = (dir) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
const branch = (dir) => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

async function run(fixer) {
  return runTarget({
    agent: 'target-honest.sh',
    mutate: withReview,
    env: { AGENT_REVIEW_CMD: `sh "${join(AGENTS, 'target-review-once.sh')}"`, AGENT_FIX_CMD: `sh "${join(AGENTS, fixer)}"` },
  });
}

test('a fix in the submodule and superproject is recorded and bundled', async () => {
  const { verdict, projectDir } = await run('target-fix-good.sh');
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.equal(verdict.review.exit, 'clean');
  const [r1] = verdict.review.rounds;
  assert.equal(r1.commit, null);
  assert.deepEqual(Object.keys(r1.targets).sort(), ['target', 'target/packages/core']);
  assert.equal(r1.targets['target/packages/core'], sha(join(projectDir, 'target', 'packages', 'core')));
  assert.equal(readFileSync(join(projectDir, 'target', 'packages', 'core', 'lib.txt'), 'utf8'), 'c\n');
  assert.equal(verdict.targets.find((t) => t.repo === 'o/sub').commits, 2);
  assert.equal(verdict.targets.find((t) => t.repo === 'o/super').commits, 2);
});

test('a fix that breaks the checks is reverted in every target repository', async () => {
  const { verdict, projectDir } = await run('target-fix-breaks.sh');
  assert.equal(verdict.review.exit, 'fix-broke-checks');
  assert.equal(verdict.review.rounds[0].reverted, true);
  const sub = join(projectDir, 'target', 'packages', 'core');
  assert.equal(readFileSync(join(sub, 'lib.txt'), 'utf8'), 'b\n');
  assert.equal(branch(sub), 'fix/add-greeting');
  assert.equal(branch(join(projectDir, 'target')), 'fix/add-greeting');
  assert.equal(verdict.targets.find((t) => t.repo === 'o/sub').commits, 1);
  assert.equal(verdict.targets.find((t) => t.repo === 'o/super').commits, 1);
});
