import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REVIEW_TOOLS, reviewTemplates, createSession, reviewStep } from '../harness/lib/review-loop.mjs';

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), 'fake-agents');
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

test('reviewers may start subagents', () => {
  assert.equal(REVIEW_TOOLS, 'Read,Glob,Grep,Write,Bash,Agent,Task');
});

test('one review step reviews, verifies and returns findings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-step-'));
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'base.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'greeting.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'greeting');
  const outDir = mkdtempSync(join(tmpdir(), 'review-step-out-'));
  const logsDir = join(outDir, 'logs');
  mkdirSync(logsDir);
  const env = {
    ...process.env, AGENT_REVIEW_CMD: `sh "${join(AGENTS, 'review-once.sh')}"`, AGENT_VERIFY_CMD: `sh "${join(AGENTS, 'verify-withdraw.sh')}"`,
  };
  const session = createSession({
    envConfig: {}, accounts: [{ token: undefined, account: null }], env, projectDir: dir, outDir, logsDir, maxTurns: 5, remainingSec: () => 60,
  });
  const warnings = [];
  const step = await reviewStep({
    n: 1, repos: [{ prefix: '', dir, base, branch: 'main' }], session, model: 'opus', templates: reviewTemplates(),
    input: { goal: '', skillDir: join(outDir, 'review-skill'), planTask: '## Task 1: x', rules: [], history: '(first review)' }, env, outDir, warnings,
  });
  assert.deepEqual(warnings, []);
  assert.equal(step.findings[0].verification, 'WITHDRAWN');
  assert.equal(step.findings[1].severity, 'low');
});
