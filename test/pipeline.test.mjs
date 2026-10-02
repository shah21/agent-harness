import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTask, parseDiff } from '../harness/run-task.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, 'fake-agents');
const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

function makeProject(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-project-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  if (mutate) {
    mutate(dir, git);
    git('commit', '-qam', 'mutate');
  }
  return dir;
}

async function run({ agent, cmd, issue = ISSUE, mutate } = {}) {
  const projectDir = makeProject(mutate);
  const outDir = mkdtempSync(join(tmpdir(), 'harness-out-'));
  const AGENT_CMD = cmd ?? `sh "${join(AGENTS, agent)}"`;
  const verdict = await runTask({ projectDir, issue, outDir, baseBranch: 'main', env: { ...process.env, AGENT_CMD } });
  return { verdict, projectDir, outDir };
}

test('parseDiff handles adds, deletes and renames', () => {
  assert.deepEqual(parseDiff('A\ta.txt\nD\tb.txt\nR100\told.txt\tnew.txt\n'), [
    { status: 'A', path: 'a.txt' },
    { status: 'D', path: 'b.txt' },
    { status: 'R', oldPath: 'old.txt', path: 'new.txt' },
  ]);
});

test('honest agent → READY_FOR_QA with a written verdict', async () => {
  const { verdict, outDir, projectDir } = await run({ agent: 'honest.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.equal(verdict.commits, 1);
  assert.deepEqual(verdict.warnings, []);
  assert.equal(verdict.taskTitle, 'Add greeting');
  assert.equal(verdict.branch, 'agent/issue-7');
  assert.equal(verdict.model, 'sonnet');
  assert.deepEqual(Object.keys(verdict.checks), ['test', 'lint']);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'verdict.json'), 'utf8')).outcome, 'READY_FOR_QA');
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim();
  assert.equal(branch, 'agent/issue-7');
});

test('agent:opus label switches the model', async () => {
  const { verdict } = await run({ agent: 'honest.sh', issue: { ...ISSUE, labels: ['agent', 'agent:opus'] } });
  assert.equal(verdict.model, 'opus');
});

test('liar → blocked by the real check', async () => {
  const { verdict } = await run({ agent: 'liar.sh' });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'gate');
  assert.deepEqual(verdict.reasons, ['check "test" failed (report claimed PASS)']);
});

test('deleting a test → blocked', async () => {
  const { verdict } = await run({ agent: 'delete-test.sh' });
  assert.match(verdict.reasons[0], /existing tests deleted or renamed: tests\/base\.test\.sh/);
});

test('editing CI → blocked', async () => {
  const { verdict } = await run({ agent: 'edit-ci.sh' });
  assert.match(verdict.reasons[0], /protected paths: \.github\/workflows\/x\.yml/);
});

test('hanging agent → killed at the timeout', async () => {
  const started = Date.now();
  const { verdict } = await run({ agent: 'hang.sh' });
  assert.equal(verdict.kind, 'agent');
  assert.match(verdict.reasons[0], /timed out/);
  assert.deepEqual(verdict.checks, {});
  assert.ok(Date.now() - started < 15000);
});

test('no report → blocked by the harness', async () => {
  const { verdict } = await run({ agent: 'no-report.sh' });
  assert.equal(verdict.kind, 'harness');
  assert.deepEqual(verdict.reasons, ['agent wrote no report']);
  assert.equal(verdict.commits, 1);
});

test('agent reports BLOCKED → its blocker is surfaced', async () => {
  const { verdict } = await run({ agent: 'blocked.sh' });
  assert.equal(verdict.kind, 'report');
  assert.deepEqual(verdict.reasons, ['Needs a secret that does not exist.']);
  assert.equal(verdict.report.requiredHumanAction, 'Provide DEPLOY_KEY.');
});

test('uncommitted changes are not counted → blocked, with a warning', async () => {
  const { verdict } = await run({ agent: 'dirty.sh' });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.deepEqual(verdict.reasons, ['check "test" failed (report claimed PASS)']);
  assert.match(verdict.warnings.join('\n'), /uncommitted changes/);
});

test('red base → blocked before the agent runs', async () => {
  const { verdict, projectDir } = await run({
    cmd: 'touch agent-ran',
    mutate: (dir) => writeFileSync(join(dir, 'value.txt'), '2\n'),
  });
  assert.equal(verdict.kind, 'gate');
  assert.equal(verdict.reasons[0], 'base is red: test failed before the agent started');
  assert.equal(existsSync(join(projectDir, 'agent-ran')), false);
});

test('unknown task number → bad task reference', async () => {
  const { verdict } = await run({ agent: 'honest.sh', issue: { ...ISSUE, body: 'plan: docs/plan.md\ntask: 9' } });
  assert.equal(verdict.kind, 'gate');
  assert.match(verdict.reasons[0], /no "Task 9:" heading in docs\/plan\.md/);
});

test('missing plan file → bad task reference', async () => {
  const { verdict } = await run({ agent: 'honest.sh', issue: { ...ISSUE, body: 'plan: docs/nope.md\ntask: 1' } });
  assert.match(verdict.reasons[0], /plan file not found: docs\/nope\.md/);
});

test('missing agent.config.json → blocked by the harness', async () => {
  const { verdict } = await run({ agent: 'honest.sh', mutate: (dir, git) => git('rm', '-q', 'agent.config.json') });
  assert.equal(verdict.kind, 'harness');
  assert.match(verdict.reasons[0], /agent\.config\.json not found/);
});

test('a planted verdict plus a broken repo cannot skip the gate', async () => {
  const { verdict, outDir } = await run({ agent: 'sabotage.sh' });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'harness');
  assert.match(verdict.reasons[0], /harness failed after the agent ran/);
  assert.equal(JSON.parse(readFileSync(join(outDir, 'verdict.json'), 'utf8')).outcome, 'BLOCKED');
});

test('ignored files left by the agent do not count → blocked', async () => {
  const { verdict } = await run({ agent: 'ignored-dep.sh' });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.deepEqual(verdict.reasons, ['check "test" failed (report claimed PASS)']);
});

test('Claude authentication failure is named, not just an exit code', async () => {
  const { verdict } = await run({ agent: 'auth-fail.sh' });
  assert.equal(verdict.kind, 'agent');
  assert.deepEqual(verdict.reasons, ['Claude authentication failed (401): check the CLAUDE_CODE_OAUTH_TOKEN secret']);
});
