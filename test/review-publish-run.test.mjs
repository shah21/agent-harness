import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LABELS } from '../harness/lib/bootstrap.mjs';

const PUBLISH = new URL('../harness/publish-review.sh', import.meta.url).pathname;
const STUBS = new URL('./stubs', import.meta.url).pathname;
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const HEAD = 'a'.repeat(40);

const base = {
  mode: 'review', kind: null, reasons: [], warnings: [], issue: 30, issueTitle: 'Review', model: 'opus',
  prs: [{ repo: 'o/r', number: 5, url: 'u', headSha: HEAD, baseSha: 'b', prefix: '' }], task: null,
};

function publish(verdict, body = 'pr: o/r#5\n') {
  const dir = mkdtempSync(join(tmpdir(), 'review-publish-'));
  writeFileSync(join(dir, 'v.json'), JSON.stringify(verdict));
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [PUBLISH], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${STUBS}:${process.env.PATH}`, GH_LOG: log, GH_ISSUE_BODY: body,
      VERDICT: join(dir, 'v.json'), REPO: 'o/r', GH_TOKEN: 'x', RUN_URL: 'https://run',
    },
  });
  return { status: r.status, stderr: r.stderr, log: readFileSync(log, 'utf8') };
}

test('labels exist', () => {
  assert.ok(LABELS.includes('review'));
  assert.ok(LABELS.includes('agent:review-done'));
});

test('a review rewrites the issue body and marks it done', () => {
  const { status, stderr, log } = publish({ ...base, outcome: 'REVIEWED', review: { verdict: 'clean', findings: [] } }, 'pr: o/r#5\nplease\n');
  assert.equal(status, 0, stderr);
  assert.match(log, /gh issue view 30 --repo o\/r --json body -q \.body/);
  assert.match(log, /gh issue edit 30 --repo o\/r --body-file \S+\npr: o\/r#5\nplease\n\n<!-- agent-pr-review -->\n## 🟢 Looks good/);
  assert.match(log, /--remove-label review --add-label agent:review-done/);
  assert.doesNotMatch(log, /gh issue comment/);
});

test('a blocked run comments and labels', () => {
  const { status, log } = publish({ ...base, outcome: 'BLOCKED', kind: 'harness', reasons: ['pull request checkout failed'], review: null });
  assert.equal(status, 0);
  assert.match(log, /--remove-label review --add-label agent:blocked/);
  assert.match(log, /gh issue comment 30[\s\S]*⛔ \*\*BLOCKED\*\* \(harness\)\n\n- pull request checkout failed/);
  assert.doesNotMatch(log, /--body-file \S+\npr:/);
});

test('waiting leaves the issue queued', () => {
  const { status, log } = publish({ ...base, outcome: 'WAITING', kind: 'usage-limit', reasons: ['x'], review: null });
  assert.equal(status, 0);
  assert.doesNotMatch(log, /--remove-label review/);
  assert.doesNotMatch(log, /gh issue comment/);
});

test('the caller template runs reviews after debug, on the owner label only', () => {
  const y = read('../templates/agent.yml');
  assert.match(y, /\n  review:\n    needs: \[agent, debug\]\n/);
  assert.match(y, /github\.event\.label\.name == 'review' && github\.event\.sender\.login == github\.repository_owner/);
  assert.match(y, /run-review\.yml@v1/);
});

test('README documents review runs', () => {
  const readme = read('../README.md');
  assert.match(readme, /^## Review runs$/m);
  for (const word of ['pr: owner/repo#123', '<!-- agent-pr-review -->', 'agent:review-done', '50,000', 'TARGET_READ_TOKEN']) assert.ok(readme.includes(word), word);
});
