import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LIMITS, reviewRepos, readRules, nearestContext, changedPaths, diffText, planTaskSection,
  historyText, findingsText, renderReviewPrompt, renderFixPrompt,
} from '../harness/lib/review-inputs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

// base commit: rules, context files (one a symlink), two source files; HEAD changes a rule and a source file.
function repo(extra = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-inputs-'));
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  write(dir, 'docs/review/rules.md', 'Rule: base\n');
  write(dir, 'AGENTS.md', 'Root context\n');
  write(dir, 'src/a/AGENTS.md', 'A context\n');
  symlinkSync('AGENTS.md', join(dir, 'src/a/CLAUDE.md'));
  write(dir, 'src/a/b/x.txt', 'x\n');
  write(dir, 'top.txt', 't\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  write(dir, 'docs/review/rules.md', 'Rule: changed\n');
  write(dir, 'src/a/b/x.txt', 'y\n');
  extra(dir);
  git('add', '-A');
  git('commit', '-qm', 'change');
  return { prefix: '', dir, base, branch: 'main' };
}

test('reviewRepos lists the consumer, then the target repositories', () => {
  const target = { branch: 'fix/x', repos: [{ path: 'target/packages/core', dir: '/t/sub', baseSha: 's1' }, { path: 'target', dir: '/t', baseSha: 's2' }] };
  assert.deepEqual(reviewRepos({ projectDir: '/p', baseSha: 'b', branch: 'agent/issue-7', target }), [
    { prefix: '', dir: '/p', base: 'b', branch: 'agent/issue-7' },
    { prefix: 'target/packages/core/', dir: '/t/sub', base: 's1', branch: 'fix/x' },
    { prefix: 'target/', dir: '/t', base: 's2', branch: 'fix/x' },
  ]);
  assert.deepEqual(reviewRepos({ projectDir: '/p', baseSha: 'b', branch: 'agent/issue-7', target: null }).length, 1);
});

test('rules are read at the base commit', () => {
  const r = repo();
  assert.deepEqual(readRules([r], ['docs/review/*.md']), [{ path: 'docs/review/rules.md', text: 'Rule: base\n' }]);
  assert.deepEqual(readRules([r], []), []);
});

test('rules in a prefixed repository are matched by their prefixed path', () => {
  const r = { ...repo(), prefix: 'target/' };
  assert.deepEqual(readRules([r], ['target/AGENTS.md']), [{ path: 'target/AGENTS.md', text: 'Root context\n' }]);
});

test('nearest context file above each changed path, symlinks skipped', () => {
  const r = repo();
  assert.deepEqual(nearestContext([r], ['src/a/b/x.txt', 'top.txt']), [
    { path: 'AGENTS.md', text: 'Root context\n' },
    { path: 'src/a/AGENTS.md', text: 'A context\n' },
  ]);
});

test('nearest context in a prefixed repository', () => {
  const consumer = repo();
  const target = { ...repo(), prefix: 'target/' };
  assert.deepEqual(nearestContext([consumer, target], ['target/src/a/b/x.txt']).map((c) => c.path), ['target/src/a/AGENTS.md']);
});

test('changed paths and the diff carry each repository prefix', () => {
  const consumer = repo();
  const target = { ...repo(), prefix: 'target/' };
  assert.deepEqual(changedPaths([consumer, target]), [
    'docs/review/rules.md', 'src/a/b/x.txt', 'target/docs/review/rules.md', 'target/src/a/b/x.txt',
  ]);
  const diff = diffText([consumer, target]);
  assert.match(diff, /^diff --git a\/src\/a\/b\/x\.txt b\/src\/a\/b\/x\.txt$/m);
  assert.match(diff, /^diff --git a\/target\/src\/a\/b\/x\.txt b\/target\/src\/a\/b\/x\.txt$/m);
});

test('a large diff is truncated', () => {
  const r = repo((dir) => write(dir, 'big.txt', 'z'.repeat(LIMITS.diff + 1000)));
  const diff = diffText([r]);
  assert.ok(diff.endsWith('[truncated]'));
  assert.ok(diff.length <= LIMITS.diff + 20);
});

test('plan task section', () => {
  const plan = '# P\n\n## Task 1: feat: one\n\nDo one.\n\n### Task 2: fix: two\n\nDo two.\n';
  assert.equal(planTaskSection(plan, 1), '## Task 1: feat: one\n\nDo one.');
  assert.equal(planTaskSection(plan, 2), '### Task 2: fix: two\n\nDo two.');
  assert.equal(planTaskSection(plan, 3), '');
});

const finding = { id: 'R1', severity: 'high', file: 'a.txt', line: 3, rule: 'plan-mismatch', problem: 'Wrong.', fix: 'Do it right.' };

test('history and findings text', () => {
  assert.equal(historyText([]), '(first review)');
  assert.equal(
    historyText([{ n: 1, findings: [finding, { ...finding, id: 'R2', severity: 'low' }], fixes: [{ id: 'R1', result: 'WONTFIX', reason: 'plan says so' }] }]),
    'Round 1:\n- R1 high a.txt:3 plan-mismatch: Wrong. → WONTFIX: plan says so\n- R2 low a.txt:3 plan-mismatch: Wrong.',
  );
  assert.equal(findingsText([finding]), '- R1 (high) a.txt:3 plan-mismatch: Wrong. Suggested fix: Do it right.');
});

test('prompts render every variable and wrap inputs as untrusted data', () => {
  const review = renderReviewPrompt(readFileSync(join(HERE, '..', 'harness', 'review-prompt.md'), 'utf8'), {
    round: 2, planTask: '## Task 1: x', diff: 'diff --git a/a b/a', rules: [{ path: 'docs/review/rules.md', text: 'Rule' }],
    contexts: [], history: '(first review)', outputPath: '/out/review-2.md',
  });
  assert.doesNotMatch(review, /\{\{/);
  assert.match(review, /review round 2/);
  assert.match(review, /<untrusted-data name="docs\/review\/rules\.md">\nRule\n<\/untrusted-data>/);
  assert.match(review, /<untrusted-data name="diff">/);
  assert.match(review, /\/out\/review-2\.md/);

  const fix = renderFixPrompt(readFileSync(join(HERE, '..', 'harness', 'fix-prompt.md'), 'utf8'), {
    round: 1, branch: 'agent/issue-7', planTask: '## Task 1: x', diff: 'd', findings: [finding], outputPath: '/out/fix-1.md',
    checks: { test: 'sh tests/run.sh' }, protectedPaths: ['.github/**'], hasSetup: false,
  });
  assert.doesNotMatch(fix, /\{\{/);
  assert.match(fix, /`fix: address review round 1`/);
  assert.match(fix, /- test: `sh tests\/run\.sh`/);
  assert.match(fix, /<untrusted-data name="findings">\n- R1 \(high\)/);
});
