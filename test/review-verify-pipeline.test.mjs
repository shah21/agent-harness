import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTask } from '../harness/run-task.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, 'fake-agents');
const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const REVIEW = { skill: 'skill', maxRounds: 2, timeout: '2m', maxTurns: 5 };

function makeProject(review) {
  const dir = mkdtempSync(join(tmpdir(), 'review-verify-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  mkdirSync(join(dir, 'skill', 'references'), { recursive: true });
  writeFileSync(join(dir, 'skill', 'SKILL.md'), '# Fixture review skill\n');
  writeFileSync(join(dir, 'skill', 'references', 'lenses.md'), 'Lenses\n');
  const configPath = join(dir, 'agent.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.review = review;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

async function run({ reviewer, verifier = 'verify-confirm.sh', fixer = 'fix-good.sh', review = REVIEW }) {
  const projectDir = makeProject(review);
  const outDir = mkdtempSync(join(tmpdir(), 'review-verify-out-'));
  const sh = (name) => `sh "${join(AGENTS, name)}"`;
  const env = {
    ...process.env, AGENT_CMD: sh('honest.sh'), AGENT_REVIEW_CMD: sh(reviewer), AGENT_VERIFY_CMD: sh(verifier), AGENT_FIX_CMD: sh(fixer),
  };
  const verdict = await runTask({ projectDir, issue: ISSUE, outDir, baseBranch: 'main', env });
  return { verdict, projectDir, outDir };
}

test('the skill is copied at base and named in the prompt', async () => {
  const { outDir } = await run({ reviewer: 'review-clean.sh' });
  assert.equal(readFileSync(join(outDir, 'review-skill', 'SKILL.md'), 'utf8'), '# Fixture review skill\n');
  assert.ok(existsSync(join(outDir, 'review-skill', 'references', 'lenses.md')));
  assert.ok(readFileSync(join(outDir, 'review-1.prompt.md'), 'utf8').includes(`Read ${join(outDir, 'review-skill')}/SKILL.md first`));
});

test('a missing skill ends the loop before any agent runs', async () => {
  const { verdict, outDir } = await run({ reviewer: 'review-clean.sh', review: { ...REVIEW, skill: 'nope' } });
  assert.equal(verdict.outcome, 'READY_FOR_QA');
  assert.equal(verdict.review.exit, 'reviewer-error');
  assert.equal(verdict.review.error, 'review skill not found: nope/SKILL.md');
  assert.deepEqual(verdict.review.rounds, []);
  assert.equal(existsSync(join(outDir, 'review-1.prompt.md')), false);
});

test('a confirmed finding is fixed', async () => {
  const { verdict } = await run({ reviewer: 'review-once.sh' });
  const [r1] = verdict.review.rounds;
  assert.equal(verdict.review.exit, 'clean');
  assert.equal(r1.findings[0].verification, 'CONFIRMED');
  assert.equal(r1.findings[1].severity, 'low');
  assert.equal(r1.findings[1].verification, undefined);
  assert.deepEqual(r1.fixes, [{ id: 'R1', result: 'FIXED' }]);
});

test('a withdrawn finding is not fixed and does not count', async () => {
  const { verdict } = await run({ reviewer: 'review-stubborn.sh', verifier: 'verify-withdraw.sh', fixer: 'fix-breaks.sh' });
  const [r1] = verdict.review.rounds;
  assert.equal(verdict.review.exit, 'clean');
  assert.equal(r1.findings[0].verification, 'WITHDRAWN');
  assert.equal(r1.findings[0].evidence, 'greeting.txt holds exactly what the task asks for');
  assert.equal(r1.fixes, undefined);
  assert.deepEqual(verdict.review.open, []);
  assert.equal(verdict.commits, 1);
});

test('a silent verifier keeps every finding', async () => {
  const { verdict } = await run({ reviewer: 'review-once.sh', verifier: 'verify-silent.sh' });
  assert.ok(verdict.warnings.includes('review round 1: verification failed; all findings kept'));
  assert.equal(verdict.review.rounds[0].findings[0].verification, 'CONFIRMED');
  assert.deepEqual(verdict.review.rounds[0].fixes, [{ id: 'R1', result: 'FIXED' }]);
});

test('a verifier that changes the checkout is reverted', async () => {
  const { verdict, projectDir } = await run({ reviewer: 'review-once.sh', verifier: 'verify-editor.sh' });
  assert.ok(verdict.warnings.includes('review round 1: the verifier changed the checkout; changes were discarded'));
  assert.equal(readFileSync(join(projectDir, 'greeting.txt'), 'utf8'), 'hello\n');
});

test('an unanchored finding is a reviewer error', async () => {
  const { verdict } = await run({ reviewer: 'review-unanchored.sh' });
  assert.equal(verdict.review.exit, 'reviewer-error');
  assert.equal(verdict.review.error, 'R1: line 5 of "greeting.txt" is not in a changed hunk');
});

test('low findings skip verification', async () => {
  const { verdict, outDir } = await run({ reviewer: 'review-low.sh' });
  assert.equal(verdict.review.exit, 'clean');
  assert.equal(existsSync(join(outDir, 'verify-1.prompt.md')), false);
});

test('the default review model is opus', async () => {
  const { verdict } = await run({ reviewer: 'review-clean.sh' });
  assert.equal(verdict.review.model, 'opus');
});
