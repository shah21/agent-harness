import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTask } from '../harness/run-task.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, 'fake-agents');
const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const REVIEW = { maxRounds: 2, timeout: '2m', maxTurns: 5 };

function makeProject(review, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-project-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  const configPath = join(dir, 'agent.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (review !== undefined) config.review = review;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

// An explicit `review: undefined` means no review block, so it must not fall back to REVIEW.
async function run({ reviewer = 'review-clean.sh', fixer = 'fix-good.sh', files, ...options } = {}) {
  const review = 'review' in options ? options.review : REVIEW;
  const projectDir = makeProject(review, files);
  const outDir = mkdtempSync(join(tmpdir(), 'review-out-'));
  const env = {
    ...process.env,
    AGENT_CMD: `sh "${join(AGENTS, 'honest.sh')}"`,
    AGENT_REVIEW_CMD: `sh "${join(AGENTS, reviewer)}"`,
    AGENT_FIX_CMD: `sh "${join(AGENTS, fixer)}"`,
  };
  const verdict = await runTask({ projectDir, issue: ISSUE, outDir, baseBranch: 'main', env });
  return { verdict, projectDir, outDir };
}

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const tip = (dir) => git(dir, 'rev-parse', 'agent/issue-7');
const onBranch = (dir) => assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/issue-7');
const allGreen = (checks) => Object.values(checks).every((c) => c.ok);

test('without a review block nothing changes', async () => {
  const { verdict, outDir } = await run({ review: undefined, reviewer: 'review-stubborn.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA');
  assert.equal('review' in verdict, false);
  assert.equal(existsSync(join(outDir, 'review-1.md')), false);
});

test('a clean first review ends the loop', async () => {
  const { verdict } = await run({ reviewer: 'review-clean.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA');
  assert.equal(verdict.review.exit, 'clean');
  assert.equal(verdict.review.model, 'sonnet');
  assert.deepEqual(verdict.review.rounds.map((r) => r.n), [1]);
  assert.deepEqual(verdict.review.open, []);
  assert.equal(verdict.commits, 1);
});

test('a high finding is fixed, verified and confirmed by the next review', async () => {
  const { verdict, projectDir } = await run({ reviewer: 'review-once.sh', fixer: 'fix-good.sh' });
  const [r1, r2] = verdict.review.rounds;
  assert.equal(verdict.review.exit, 'clean');
  assert.deepEqual(r1.fixes, [{ id: 'R1', result: 'FIXED' }]);
  assert.equal(r1.commit, tip(projectDir));
  assert.equal(r1.reverted, false);
  assert.ok(allGreen(r1.checks));
  assert.equal(r2.n, 2);
  assert.equal(verdict.commits, 2);
  assert.ok(verdict.diff.some((d) => d.path === 'notes.txt'));
  assert.ok(allGreen(verdict.checks));
  assert.deepEqual(verdict.review.open, []);
  assert.equal(git(projectDir, 'log', '-1', '--format=%s'), 'fix: address review round 1');
});

test('low findings never start a fix', async () => {
  const { verdict } = await run({ reviewer: 'review-low.sh', fixer: 'fix-breaks.sh' });
  assert.equal(verdict.review.exit, 'clean');
  assert.equal(verdict.review.rounds[0].findings[0].severity, 'low');
  assert.equal(verdict.review.rounds[0].fixes, undefined);
  assert.equal(verdict.commits, 1);
});

test('maxRounds 1 reviews without fixing', async () => {
  const { verdict } = await run({ reviewer: 'review-stubborn.sh', fixer: 'fix-breaks.sh', review: { ...REVIEW, maxRounds: 1 } });
  assert.equal(verdict.review.exit, 'max-rounds');
  assert.equal(verdict.review.rounds.length, 1);
  assert.equal(verdict.review.rounds[0].fixes, undefined);
  assert.deepEqual(verdict.review.open.map((f) => f.id), ['R1']);
  assert.equal(verdict.outcome, 'READY_FOR_QA');
});

test('the round cap stops new findings', async () => {
  const { verdict } = await run({ reviewer: 'review-shifting.sh', fixer: 'fix-good.sh' });
  assert.equal(verdict.review.exit, 'max-rounds');
  assert.equal(verdict.review.rounds.length, 2);
  assert.deepEqual(verdict.review.open.map((f) => f.rule), ['rule-2']);
  assert.equal(verdict.commits, 2);
});

test('the same findings again end the loop', async () => {
  const { verdict } = await run({ reviewer: 'review-stubborn.sh', fixer: 'fix-good.sh', review: { ...REVIEW, maxRounds: 3 } });
  assert.equal(verdict.review.exit, 'no-progress');
  assert.equal(verdict.review.rounds.length, 2);
  assert.deepEqual(verdict.review.open.map((f) => f.id), ['R1']);
});

test('a fix that breaks the checks is reverted to the last green state', async () => {
  const { verdict, projectDir } = await run({ reviewer: 'review-stubborn.sh', fixer: 'fix-breaks.sh' });
  assert.equal(verdict.review.exit, 'fix-broke-checks');
  assert.equal(verdict.review.rounds[0].reverted, true);
  assert.equal(verdict.review.rounds[0].checks.test.ok, false);
  assert.equal(readFileSync(join(projectDir, 'greeting.txt'), 'utf8'), 'hello\n');
  assert.equal(verdict.commits, 1);
  assert.ok(allGreen(verdict.checks));
  assert.deepEqual(verdict.review.open.map((f) => f.result), ['REVERTED']);
  onBranch(projectDir);
});

test('a fix that touches a protected path is reverted', async () => {
  const { verdict, projectDir } = await run({ reviewer: 'review-stubborn.sh', fixer: 'fix-protected.sh' });
  assert.equal(verdict.review.exit, 'gate');
  assert.match(verdict.review.error, /protected paths: \.github\/workflows\/x\.yml/);
  assert.equal(existsSync(join(projectDir, '.github')), false);
  assert.equal(verdict.commits, 1);
});

test('a fix that deletes a test is reverted', async () => {
  const { verdict, projectDir } = await run({ reviewer: 'review-stubborn.sh', fixer: 'fix-delete-test.sh' });
  assert.equal(verdict.review.exit, 'gate');
  assert.match(verdict.review.error, /existing tests deleted or renamed: tests\/base\.test\.sh/);
  assert.ok(existsSync(join(projectDir, 'tests', 'base.test.sh')));
});

test('a fixer that leaves the branch is reverted', async () => {
  const { verdict, projectDir } = await run({ reviewer: 'review-stubborn.sh', fixer: 'fix-switch.sh' });
  assert.equal(verdict.review.exit, 'gate');
  assert.match(verdict.review.error, /fixer switched the repository off agent\/issue-7/);
  onBranch(projectDir);
  assert.equal(verdict.commits, 1);
});

test('a reviewer that changes the checkout is reverted and the loop goes on', async () => {
  const { verdict, projectDir } = await run({ reviewer: 'review-editor.sh' });
  assert.equal(verdict.review.exit, 'clean');
  assert.ok(verdict.warnings.includes('review round 1: the reviewer changed the checkout; changes were discarded'));
  assert.equal(readFileSync(join(projectDir, 'greeting.txt'), 'utf8'), 'hello\n');
  assert.equal(existsSync(join(projectDir, 'stray.txt')), false);
  assert.equal(verdict.commits, 1);
});

test('invalid reviewer output ends the loop with an error', async () => {
  const { verdict } = await run({ reviewer: 'review-bad.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA');
  assert.equal(verdict.review.exit, 'reviewer-error');
  assert.match(verdict.review.error, /no ```json block/);
  assert.deepEqual(verdict.review.rounds, []);
});

test('a finding outside the diff is a reviewer error', async () => {
  const { verdict } = await run({ reviewer: 'review-outside.sh' });
  assert.equal(verdict.review.exit, 'reviewer-error');
  assert.match(verdict.review.error, /"value\.txt" is not in the diff/);
});

test('declined findings keep their reason', async () => {
  const { verdict } = await run({ reviewer: 'review-stubborn.sh', fixer: 'fix-decline.sh' });
  assert.deepEqual(verdict.review.rounds[0].fixes, [{ id: 'R1', result: 'WONTFIX', reason: 'the plan asks for this shape' }]);
  assert.equal(verdict.review.rounds[0].commit, null);
  assert.equal(verdict.review.exit, 'no-progress');
});

test('a FIXED claim without a commit is unaddressed', async () => {
  const { verdict } = await run({ reviewer: 'review-stubborn.sh', fixer: 'fix-claims.sh' });
  assert.deepEqual(verdict.review.rounds[0].fixes, [{ id: 'R1', result: 'UNADDRESSED' }]);
});

test('uncommitted fixer changes are stashed with a warning', async () => {
  const { verdict, projectDir } = await run({ reviewer: 'review-once.sh', fixer: 'fix-dirty.sh' });
  assert.equal(verdict.review.exit, 'clean');
  assert.ok(verdict.warnings.includes('review round 1: the fixer left uncommitted changes; they were stashed'));
  assert.equal(existsSync(join(projectDir, 'scratch.txt')), false);
});

test('a usage limit in the fixer keeps the last green state and stays READY', async () => {
  const { verdict, projectDir } = await run({ reviewer: 'review-stubborn.sh', fixer: 'fix-limited.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA');
  assert.equal(verdict.review.exit, 'usage-limit');
  assert.equal(verdict.commits, 1);
  assert.equal(existsSync(join(projectDir, 'notes.txt')), false);
});

test('a usage limit in the reviewer stays READY', async () => {
  const { verdict } = await run({ reviewer: 'review-limited.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA');
  assert.equal(verdict.review.exit, 'usage-limit');
});

test('a review longer than the budget ends with budget', async () => {
  const { verdict } = await run({ reviewer: 'review-slow.sh', review: { ...REVIEW, timeout: '1s' } });
  assert.equal(verdict.review.exit, 'budget');
  assert.equal(verdict.outcome, 'READY_FOR_QA');
});

test('rule files and the nearest context file reach the review prompt', async () => {
  const { outDir } = await run({
    reviewer: 'review-clean.sh',
    review: { ...REVIEW, rules: ['review-rules.md'] },
    files: { 'review-rules.md': 'Rule: greetings are lowercase\n', 'AGENTS.md': 'Project context\n' },
  });
  const prompt = readFileSync(join(outDir, 'review-1.prompt.md'), 'utf8');
  assert.match(prompt, /<untrusted-data name="review-rules\.md">\nRule: greetings are lowercase\n/);
  assert.match(prompt, /<untrusted-data name="AGENTS\.md">\nProject context\n/);
  assert.match(prompt, /## Task 1: Add greeting/);
  assert.match(prompt, /greeting\.txt/);
});
