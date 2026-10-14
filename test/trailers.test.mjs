import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../harness/lib/config.mjs';
import { trailerViolations } from '../harness/lib/gate.mjs';
import { trailersRule } from '../harness/lib/agent.mjs';
import { runTask } from '../harness/run-task.mjs';
import { runTarget } from './helpers/target-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, 'fake-agents');
const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const FORBID = ['Co-Authored-By'];

test('config: default empty, values kept, invalid rejected', () => {
  const base = { install: 'x', checks: { t: 'y' } };
  assert.deepEqual(loadConfig(JSON.stringify(base)).forbiddenTrailers, []);
  assert.deepEqual(loadConfig(JSON.stringify({ ...base, forbiddenTrailers: FORBID })).forbiddenTrailers, FORBID);
  for (const bad of ['x', [''], ['Co Authored'], ['-x'], [3]]) {
    assert.throws(() => loadConfig(JSON.stringify({ ...base, forbiddenTrailers: bad })), /"forbiddenTrailers" must be an array of trailer names like "Co-Authored-By"/);
  }
});

test('only forbidden keys count', () => {
  const commits = [{ sha: 'aaaaaaa1', body: 'Add x\n\nNote: this is fine\nSigned-off-by: A <a@b>' }];
  assert.deepEqual(trailerViolations(commits, FORBID), []);
  assert.deepEqual(trailerViolations(commits, []), []);
});

test('keys match case-insensitively', () => {
  const commits = [
    { sha: 'aaaaaaa1111', body: 'Add x\n\nco-authored-by: A <a@b>' },
    { sha: 'bbbbbbb2222', body: 'Add y' },
    { sha: 'ccccccc3333', body: 'Add z\n\nCo-Authored-By: B <b@c>' },
  ];
  assert.deepEqual(trailerViolations(commits, FORBID), ['commit messages carry forbidden trailers: aaaaaaa, ccccccc']);
});

test('prompt rule only when configured', () => {
  assert.equal(trailersRule([]), '');
  assert.equal(trailersRule(['Co-Authored-By', 'Signed-off-by']),
    '\n\n## Commit messages\n\nDo not add these trailers to any commit message: Co-Authored-By, Signed-off-by. Commits that carry them are rejected.\n');
});

function project(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'trailers-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  mkdirSync(join(dir, 'skill'), { recursive: true });
  writeFileSync(join(dir, 'skill', 'SKILL.md'), '# Fixture review skill\n');
  const path = join(dir, 'agent.config.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...extra }, null, 2));
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

async function run(agent, extra, env = {}) {
  const projectDir = project(extra);
  const outDir = mkdtempSync(join(tmpdir(), 'trailers-out-'));
  const verdict = await runTask({
    projectDir, issue: ISSUE, outDir, baseBranch: 'main', env: { ...process.env, AGENT_CMD: `sh "${join(AGENTS, agent)}"`, ...env },
  });
  return { verdict, prompt: readFileSync(join(outDir, 'prompt.md'), 'utf8') };
}

test('a forbidden trailer blocks the task and the prompt names it', async () => {
  const { verdict, prompt } = await run('honest-trailer.sh', { forbiddenTrailers: FORBID });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'gate');
  assert.match(verdict.reasons[0], /^commit messages carry forbidden trailers: [0-9a-f]{7}$/);
  assert.match(prompt, /## Commit messages\n\nDo not add these trailers to any commit message: Co-Authored-By\./);
});

test('without the setting trailers are allowed and the prompt is unchanged', async () => {
  const { verdict, prompt } = await run('honest-trailer.sh', {});
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.doesNotMatch(prompt, /## Commit messages/);
});

test('a review fix with a forbidden trailer is reverted', async () => {
  const sh = (name) => `sh "${join(AGENTS, name)}"`;
  const { verdict } = await run('honest.sh', {
    forbiddenTrailers: FORBID, review: { skill: 'skill', maxRounds: 2, timeout: '2m', maxTurns: 5 },
  }, { AGENT_REVIEW_CMD: sh('review-stubborn.sh'), AGENT_VERIFY_CMD: sh('verify-confirm.sh'), AGENT_FIX_CMD: sh('fix-trailer.sh') });
  assert.equal(verdict.outcome, 'READY_FOR_QA');
  assert.equal(verdict.review.exit, 'gate');
  assert.match(verdict.review.error, /commit messages carry forbidden trailers/);
  assert.equal(verdict.commits, 1);
});

test('a trailer in a target repository blocks', async () => {
  const { verdict } = await runTarget({
    agent: 'target-trailer.sh',
    mutate: (dir) => {
      const path = join(dir, 'agent.config.json');
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), forbiddenTrailers: FORBID }, null, 2));
    },
  });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.match(verdict.reasons[0], /^commit messages carry forbidden trailers: /);
});
