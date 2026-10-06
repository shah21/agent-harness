import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTask } from '../harness/run-task.mjs';
import { renderPrBody, renderComment } from '../harness/lib/format.mjs';
import { selectNext, taskMarker } from '../harness/lib/queue.mjs';

// Today's output for a consumer without "target". Must never change.
const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'no-target.json');
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'compat-project-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

function publishLog(projectDir, verdict) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-publish-'));
  execFileSync('git', ['-C', projectDir, 'bundle', 'create', join(dir, 'branch.bundle'), 'agent/issue-7'], { stdio: 'ignore' });
  const remote = join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [join(HERE, '..', 'harness', 'publish.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(HERE, 'stubs')}:${process.env.PATH}`,
      GH_LOG: log, VERDICT: join(dir, 'verdict.json'), REPO: 'o/r', GH_TOKEN: 'x',
      RUN_URL: 'https://run', BUNDLE: join(dir, 'branch.bundle'), PUSH_REMOTE: remote,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(log, 'utf8').replace(/--body-file \S+/g, '--body-file <file>');
}

async function snapshot() {
  const projectDir = project();
  const outDir = mkdtempSync(join(tmpdir(), 'compat-out-'));
  const AGENT_CMD = `sh "${join(HERE, 'fake-agents', 'honest.sh')}"`;
  const verdict = await runTask({ projectDir, issue: ISSUE, outDir, baseBranch: 'main', env: { ...process.env, AGENT_CMD } });
  const v = JSON.parse(JSON.stringify(verdict));
  delete v.baseSha;
  for (const c of Object.values(v.checks)) c.durationSec = 0;
  return {
    verdict: v,
    prompt: readFileSync(join(outDir, 'prompt.md'), 'utf8').replaceAll(outDir, '<out>'),
    prBody: renderPrBody(v),
    readyComment: renderComment(v, { runUrl: 'https://run', prUrl: 'https://pr' }),
    blockedComment: renderComment({ ...v, outcome: 'BLOCKED', kind: 'gate', reasons: ['x'] }, { runUrl: 'https://run' }),
    selection: selectNext({
      issues: [{ number: 9, title: 'T2', body: 'plan: docs/plan.md\ntask: 2', labels: [{ name: 'agent' }] }],
      prs: [{ headRefName: 'agent/issue-7', body: taskMarker({ plan: 'docs/plan.md', task: 1, issue: 7 }), isCrossRepository: false }],
      defaultBranch: 'main',
    }),
    publishLog: publishLog(projectDir, v),
  };
}

test('a consumer without "target" produces exactly the golden output', async () => {
  const actual = await snapshot();
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepEqual(actual, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});
