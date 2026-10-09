import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PUBLISH = new URL('../harness/publish-debug.sh', import.meta.url).pathname;
const STUBS = new URL('./stubs', import.meta.url).pathname;

const report = {
  status: 'FINDINGS', problem: 'p', reproduction: 'NOT_ATTEMPTED', evidence: 'e', hypotheses: [{ text: 'h - CONFIRMED - w', tag: 'CONFIRMED' }],
  rootCause: 'c', owningModule: 'm', nextAction: 'n', unknowns: 'None', humanInput: 'None',
};
const verdict = (over = {}) => ({
  mode: 'debug', outcome: 'FINDINGS', kind: null, reasons: [], warnings: [], issue: 9, issueTitle: 'T',
  ref: null, investigated: [], report, reportText: 'x', ...over,
});

function publish(v, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-debug-'));
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(v));
  const r = spawnSync('bash', [PUBLISH], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${STUBS}:${process.env.PATH}`, GH_LOG: log,
      VERDICT: join(dir, 'verdict.json'), REPO: 'o/r', GH_TOKEN: 'x', RUN_URL: 'https://run', ...extraEnv,
    },
  });
  return { status: r.status, stderr: r.stderr, log: readFileSync(log, 'utf8') };
}

test('FINDINGS swaps debug for agent:debug-done and comments', () => {
  const r = publish(verdict());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /gh issue edit 9 --repo o\/r --remove-label agent:running --remove-label agent:blocked --remove-label agent:debug-done/);
  assert.match(r.log, /gh issue edit 9 --repo o\/r --remove-label debug --add-label agent:debug-done/);
  assert.match(r.log, /gh issue comment 9 --repo o\/r --body-file/);
  assert.match(r.log, /🔎 \*\*FINDINGS\*\*/);
  assert.match(r.log, /<!-- agent-debug -->/);
  assert.doesNotMatch(r.log, /pr create|pr edit|git push/);
});

test('INCONCLUSIVE is labelled like FINDINGS', () => {
  assert.match(publish(verdict({ outcome: 'INCONCLUSIVE' })).log, /--remove-label debug --add-label agent:debug-done/);
});

test('BLOCKED swaps debug for agent:blocked', () => {
  const r = publish(verdict({ outcome: 'BLOCKED', kind: 'agent', reasons: ['agent finished without writing a report'], report: null }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /--remove-label debug --add-label agent:blocked/);
  assert.match(r.log, /⛔ \*\*BLOCKED\*\* \(agent\)/);
});

test('WAITING keeps the debug label so the issue stays queued', () => {
  const r = publish(verdict({ outcome: 'WAITING', kind: 'usage-limit', reasons: ['usage limit reached on all 1 Claude accounts'], report: null }));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.log, /--remove-label debug /);
  assert.doesNotMatch(r.log, /--add-label/);
  assert.match(r.log, /⏸️ \*\*WAITING\*\*/);
});
