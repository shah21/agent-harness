import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDebug } from '../harness/debug-run.mjs';
import { makeTargetProject } from './helpers/target-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, 'fake-agents');
const ISSUE = { number: 9, title: 'Query fails', body: 'The query fails with a 500.\n', labels: ['debug'] };
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

function makeProject({ config, files, prepare } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'debug-project-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  if (config) {
    const p = join(dir, 'agent.config.json');
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), ...config }));
  }
  for (const [path, text] of Object.entries(files ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (prepare) prepare(dir);
  const git = (...a) => execFileSync('git', [...ID, ...a], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

async function run({ agent, issue = ISSUE, ...project } = {}) {
  const projectDir = makeProject(project);
  const outDir = mkdtempSync(join(tmpdir(), 'debug-out-'));
  const verdict = await runDebug({ projectDir, issue, outDir, env: { ...process.env, AGENT_CMD: `sh "${join(AGENTS, agent)}"` } });
  return { verdict, projectDir, outDir };
}

test('a good report becomes FINDINGS and the verdict is written', async () => {
  const { verdict, outDir } = await run({ agent: 'debug-findings.sh' });
  assert.equal(verdict.outcome, 'FINDINGS', JSON.stringify(verdict));
  assert.equal(verdict.mode, 'debug');
  assert.equal(verdict.kind, null);
  assert.deepEqual(verdict.warnings, []);
  assert.equal(verdict.report.rootCause, 'value.txt holds a bad value');
  assert.equal(verdict.model, 'sonnet');
  assert.equal(verdict.investigated.length, 1);
  assert.match(verdict.investigated[0].sha, /^[0-9a-f]{40}$/);
  assert.equal(JSON.parse(readFileSync(join(outDir, 'verdict.json'), 'utf8')).outcome, 'FINDINGS');
});

test('the prompt carries the issue text, the skill and the report path', async () => {
  const { outDir } = await run({ agent: 'debug-findings.sh' });
  const prompt = readFileSync(join(outDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /Issue: #9 — Query fails/);
  assert.match(prompt, /The query fails with a 500\./);
  assert.match(prompt, /NO CONCLUSION WITHOUT EVIDENCE/);
  assert.ok(prompt.includes(join(outDir, 'report.md')));
});

test('agent:opus switches the model', async () => {
  const { verdict } = await run({ agent: 'debug-findings.sh', issue: { ...ISSUE, labels: ['debug', 'agent:opus'] } });
  assert.equal(verdict.model, 'opus');
});

test('weak findings are downgraded', async () => {
  const { verdict } = await run({ agent: 'debug-weak.sh' });
  assert.equal(verdict.outcome, 'INCONCLUSIVE');
  assert.match(verdict.warnings[0], /FINDINGS downgraded to INCONCLUSIVE/);
});

test('an agent that edits, commits and adds files is reverted but its report is kept', async () => {
  const { verdict, projectDir } = await run({ agent: 'debug-editor.sh' });
  assert.equal(verdict.outcome, 'FINDINGS', JSON.stringify(verdict));
  assert.ok(verdict.warnings.some((w) => /agent modified the checkout; changes were discarded/.test(w)));
  assert.equal(readFileSync(join(projectDir, 'value.txt'), 'utf8'), '1\n');
  assert.equal(existsSync(join(projectDir, 'junk.txt')), false);
  assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim(), '1');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' }).trim(), '');
});

test('no report is BLOCKED (agent)', async () => {
  const { verdict } = await run({ agent: 'debug-no-report.sh' });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'agent');
  assert.deepEqual(verdict.reasons, ['agent finished without writing a report']);
});

test('an unreadable report is BLOCKED (agent) and names the problem', async () => {
  const { verdict } = await run({ agent: 'debug-bad-report.sh' });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.match(verdict.reasons[0], /^invalid report: missing PROBLEM; missing REPRODUCTION/);
});

test('an agent-declared BLOCKED report is kept', async () => {
  const { verdict } = await run({ agent: 'debug-blocked.sh' });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'agent');
  assert.equal(verdict.report.humanInput, 'Attach the service log.');
});

test('timeout with a report is INCONCLUSIVE', async () => {
  const { verdict } = await run({ agent: 'debug-partial.sh', config: { debug: { timeout: '1s' } } });
  assert.equal(verdict.outcome, 'INCONCLUSIVE');
  assert.ok(verdict.warnings.some((w) => /timed out; the report may be partial/.test(w)));
});

test('timeout without a report is BLOCKED', async () => {
  const { verdict } = await run({ agent: 'hang.sh', config: { debug: { timeout: '1s' } } });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.deepEqual(verdict.reasons, ['agent timed out before writing a report']);
});

test('a context file is read from the repository and put in the prompt', async () => {
  const { verdict, outDir } = await run({
    agent: 'debug-findings.sh',
    issue: { ...ISSUE, body: 'context: context/handoff.md\nThe query fails.\n' },
    files: { 'context/handoff.md': 'HANDOFF TEXT' },
  });
  assert.equal(verdict.outcome, 'FINDINGS');
  assert.match(readFileSync(join(outDir, 'prompt.md'), 'utf8'), /HANDOFF TEXT/);
});

test('a missing context file blocks before the agent runs', async () => {
  const { verdict, outDir } = await run({ agent: 'debug-findings.sh', issue: { ...ISSUE, body: 'context: nope.md\nbug\n' } });
  assert.deepEqual(verdict.reasons, ['context file not found: nope.md']);
  assert.equal(verdict.kind, 'gate');
  assert.equal(existsSync(join(outDir, 'prompt.md')), false);
});

test('a context symlink out of the repository is blocked', async () => {
  const { verdict } = await run({
    agent: 'debug-findings.sh',
    issue: { ...ISSUE, body: 'context: context/leak.md\nbug\n' },
    prepare: (dir) => {
      mkdirSync(join(dir, 'context'));
      symlinkSync('/etc/hosts', join(dir, 'context', 'leak.md'));
    },
  });
  assert.deepEqual(verdict.reasons, ['context path escapes the repository: context/leak.md']);
});

test('an unsafe ref blocks before the agent runs', async () => {
  const { verdict, outDir } = await run({ agent: 'debug-findings.sh', issue: { ...ISSUE, body: 'ref: --upload-pack=x\nbug\n' } });
  assert.equal(verdict.kind, 'gate');
  assert.match(verdict.reasons[0], /^bad issue: ref is not allowed/);
  assert.equal(existsSync(join(outDir, 'prompt.md')), false);
});

test('a ref is recorded in the verdict', async () => {
  const { verdict } = await run({ agent: 'debug-findings.sh', issue: { ...ISSUE, body: 'ref: v1.2.3\nbug\n' } });
  assert.equal(verdict.ref, 'v1.2.3');
});

test('edits inside the target clone and its submodule are reverted', async () => {
  const { projectDir } = makeTargetProject();
  const outDir = mkdtempSync(join(tmpdir(), 'debug-out-'));
  const verdict = await runDebug({
    projectDir, issue: ISSUE, outDir,
    env: { ...process.env, AGENT_CMD: `sh "${join(AGENTS, 'debug-target-editor.sh')}"` },
  });
  assert.equal(verdict.outcome, 'FINDINGS', JSON.stringify(verdict.reasons));
  assert.ok(verdict.warnings.some((w) => /agent modified the checkout/.test(w)));
  assert.equal(readFileSync(join(projectDir, 'target', 'app.txt'), 'utf8'), 'app\n');
  assert.equal(readFileSync(join(projectDir, 'target', 'packages', 'core', 'lib.txt'), 'utf8'), 'a\n');
  assert.deepEqual(verdict.investigated.map((i) => i.path), ['.', 'target/packages/core', 'target']);
  assert.match(readFileSync(join(outDir, 'prompt.md'), 'utf8'), /clone of `o\/super`/);
});
