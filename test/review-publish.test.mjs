import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { LABELS } from '../harness/lib/bootstrap.mjs';

const PUBLISH = new URL('../harness/publish.sh', import.meta.url).pathname;
const STUBS = new URL('./stubs', import.meta.url).pathname;
const README = new URL('../README.md', import.meta.url).pathname;
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const ok = { ok: true, exitCode: 0, timedOut: false, durationSec: 1 };
const finding = { id: 'R1', severity: 'high', file: 'greeting.txt', line: 1, rule: 'plan-mismatch', problem: 'Wrong.', fix: '' };

const verdict = (review) => ({
  outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings: [],
  issue: 7, issueTitle: 'Task 1', plan: 'docs/p.md', task: 1, taskTitle: 'Add greeting',
  baseBranch: 'main', branch: 'agent/issue-7', model: 'sonnet', commits: 1, checks: { test: ok },
  report: { summary: 'Added greeting.', selfReview: 'Scoped.', knownIssues: 'None' }, reportText: 'STATUS: READY_FOR_QA',
  ...(review ? { review } : {}),
});

function publish(v, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-publish-'));
  const src = join(dir, 'src');
  execFileSync('git', ['init', '-q', '-b', 'agent/issue-7', src]);
  writeFileSync(join(src, 'greeting.txt'), 'hello\n');
  execFileSync('git', [...ID, 'add', '-A'], { cwd: src });
  execFileSync('git', [...ID, 'commit', '-qm', 'work'], { cwd: src });
  execFileSync('git', ['bundle', 'create', join(dir, 'branch.bundle'), 'agent/issue-7'], { cwd: src, stdio: 'ignore' });
  const remote = join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(v));
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [PUBLISH], {
    encoding: 'utf8',
    env: {
      ...process.env, ...extraEnv, PATH: `${STUBS}:${process.env.PATH}`, GH_LOG: log,
      VERDICT: join(dir, 'verdict.json'), REPO: 'o/r', GH_TOKEN: 'x', RUN_URL: 'https://run',
      BUNDLE: join(dir, 'branch.bundle'), PUSH_REMOTE: remote,
    },
  });
  return { status: r.status, stderr: r.stderr, log: readFileSync(log, 'utf8') };
}

const twoRounds = {
  model: 'sonnet', exit: 'no-progress',
  rounds: [{ n: 1, findings: [finding], fixes: [{ id: 'R1', result: 'FIXED' }], commit: 'abc1234', checks: { test: ok }, reverted: false }, { n: 2, findings: [finding] }],
  open: [finding],
};

test('the review label exists', () => {
  assert.ok(LABELS.includes('agent:review-open'));
});

test('one comment per round, then a summary, then the label', () => {
  const { status, stderr, log } = publish(verdict(twoRounds));
  assert.equal(status, 0, stderr);
  const r1 = log.indexOf('<!-- agent-review round=1 -->');
  const r2 = log.indexOf('<!-- agent-review round=2 -->');
  const summary = log.indexOf('<!-- agent-review summary -->');
  const label = log.indexOf('--add-label agent:review-open');
  assert.ok(log.indexOf('READY_FOR_QA') < r1 && r1 < r2 && r2 < summary && summary < label, log);
});

test('no open findings → no label', () => {
  const { status, log } = publish(verdict({ ...twoRounds, exit: 'clean', open: [] }));
  assert.equal(status, 0);
  assert.match(log, /<!-- agent-review summary -->/);
  assert.doesNotMatch(log, /--add-label agent:review-open/);
});

test('no review → no review comments and no label changes', () => {
  const { status, log } = publish(verdict(null));
  assert.equal(status, 0);
  assert.doesNotMatch(log, /agent-review/);
  assert.doesNotMatch(log, /agent:review-open/);
});

test('a failed round comment does not stop the others or fail the job', () => {
  const { status, log } = publish(verdict(twoRounds), { GH_FAIL_COMMENT_CONTAINING: 'agent-review round=1' });
  assert.equal(status, 0);
  assert.match(log, /<!-- agent-review round=2 -->/);
  assert.match(log, /<!-- agent-review summary -->/);
  assert.match(log, /--add-label agent:review-open/);
  assert.doesNotMatch(log, /--add-label agent:blocked/);
});

test('README documents the review loop', () => {
  const readme = readFileSync(README, 'utf8');
  assert.match(readme, /^## Review loop$/m);
  for (const word of ['"review"', 'maxRounds', 'agent:review-open', 'AGENTS.md', '{review}']) assert.ok(readme.includes(word), word);
});
