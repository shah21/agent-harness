import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runReview } from '../harness/review-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, 'fake-agents');
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const ISSUE = { number: 30, title: 'Review greeting', body: 'pr: o/r#5', labels: ['review'] };
const REVIEW = { skill: 'skill', maxRounds: 1, timeout: '2m', maxTurns: 5 };

// The consumer at a pull request head: main plus a feature commit adding greeting.txt, checked out detached.
function project(review = REVIEW) {
  const dir = mkdtempSync(join(tmpdir(), 'review-run-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  mkdirSync(join(dir, 'skill'), { recursive: true });
  writeFileSync(join(dir, 'skill', 'SKILL.md'), '# Fixture review skill\n');
  const path = join(dir, 'agent.config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (review) config.review = review;
  writeFileSync(path, JSON.stringify(config, null, 2));
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'greeting.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'Add greeting');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', head);
  return { dir, base, head, git };
}

async function run({ reviewer = 'review-once.sh', verifier = 'verify-confirm.sh', review = REVIEW, task = null, checked = true, headOverride } = {}) {
  const p = project(review);
  const outDir = mkdtempSync(join(tmpdir(), 'review-run-out-'));
  const pr = { repo: 'o/r', number: 5, url: 'https://github.com/o/r/pull/5', title: 'Add greeting', body: 'Adds a greeting.', headSha: p.head, baseRef: 'main', lines: 1 };
  const selection = { issue: ISSUE, prs: [pr], context: null, task, skip: null };
  if (checked) {
    writeFileSync(join(outDir, 'prs-checked.json'), JSON.stringify([
      { repo: 'o/r', number: 5, dir: '.', prefix: '', auth: 'consumer', headSha: headOverride ?? p.head, baseRef: 'main', baseSha: p.base },
    ]));
  }
  const sh = (name) => `sh "${join(AGENTS, name)}"`;
  const env = { ...process.env, AGENT_CMD: 'true', AGENT_REVIEW_CMD: sh(reviewer), AGENT_VERIFY_CMD: sh(verifier) };
  const verdict = await runReview({ projectDir: p.dir, issue: ISSUE, outDir, selection, defaultBranch: 'main', env });
  return { verdict, outDir, ...p };
}

test('reviews a pull request', async () => {
  const { verdict, head, git, outDir } = await run();
  assert.equal(verdict.mode, 'review');
  assert.equal(verdict.outcome, 'REVIEWED', JSON.stringify(verdict.reasons));
  assert.equal(verdict.review.verdict, 'changes');
  assert.equal(verdict.review.findings[0].verification, 'CONFIRMED');
  assert.deepEqual(verdict.prs, [{ repo: 'o/r', number: 5, url: 'https://github.com/o/r/pull/5', headSha: head, baseSha: verdict.prs[0].baseSha, prefix: '' }]);
  assert.equal(git('rev-parse', 'HEAD'), head);
  const prompt = readFileSync(join(outDir, 'review-1.prompt.md'), 'utf8');
  assert.match(prompt, /### o\/r#5: Add greeting\n\nAdds a greeting\./);
  assert.match(prompt, /no plan task found/);
  assert.ok(existsSync(join(outDir, 'review-skill', 'SKILL.md')));
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'verdict.json'), 'utf8')).outcome, 'REVIEWED');
});

test('a clean review and a withdrawn finding both look good', async () => {
  assert.equal((await run({ reviewer: 'review-clean.sh' })).verdict.review.verdict, 'clean');
  assert.equal((await run({ reviewer: 'review-stubborn.sh', verifier: 'verify-withdraw.sh' })).verdict.review.verdict, 'clean');
});

test('the plan task reaches the prompt when the pull request came from a harness task', async () => {
  const { outDir } = await run({ task: { plan: 'docs/plan.md', task: 1, issue: 7 } });
  assert.match(readFileSync(join(outDir, 'review-1.prompt.md'), 'utf8'), /## Task 1: Add greeting/);
});

test('blocked runs', async () => {
  assert.deepEqual((await run({ review: null })).verdict.reasons, ['review runs need a "review" block with a "skill" in agent.config.json']);
  const missing = await run({ checked: false });
  assert.deepEqual([missing.verdict.kind, missing.verdict.reasons], ['harness', ['pull request checkout failed']]);
  const moved = await run({ headOverride: 'f'.repeat(40) });
  assert.deepEqual(moved.verdict.reasons, ['pull request checkout failed']);
  const noSkill = await run({ review: { ...REVIEW, skill: 'nope' } });
  assert.deepEqual([noSkill.verdict.kind, noSkill.verdict.reasons], ['agent', ['review skill not found: nope/SKILL.md']]);
  const bad = await run({ reviewer: 'review-bad.sh' });
  assert.equal(bad.verdict.kind, 'agent');
  assert.match(bad.verdict.reasons[0], /^invalid review: no ```json block/);
});

test('a usage limit waits', async () => {
  const { verdict } = await run({ reviewer: 'review-limited.sh' });
  assert.equal(verdict.outcome, 'WAITING');
});

test('a reviewer that changes the checkout is reverted', async () => {
  const { verdict, head, git, dir } = await run({ reviewer: 'review-editor.sh' });
  assert.equal(verdict.outcome, 'REVIEWED');
  assert.ok(verdict.warnings.includes('review round 1: the reviewer changed the checkout; changes were discarded'));
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(dir, 'greeting.txt'), 'utf8'), 'hello\n');
});
