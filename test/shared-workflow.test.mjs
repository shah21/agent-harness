import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintNeutralNames, lintEnvExpressions } from '../harness/lib/neutral.mjs';
import { renderSharedWorkflow, SLOTS } from '../harness/lib/shared-workflow.mjs';

const root = join(import.meta.dirname, '..');
const wf = readFileSync(join(root, '.github/workflows/run-shared.yml'), 'utf8');
const caller = readFileSync(join(root, 'templates/runner.yml'), 'utf8');

// Jobs, split at their two-space indentation under `jobs:`.
const jobsText = wf.slice(wf.indexOf('\njobs:\n') + 7);
const jobs = Object.fromEntries(jobsText.split(/\n(?=  [a-z_0-9]+:\n)/).map((b) => [/^\s*([a-z_0-9]+):/.exec(b)[1], b]));
const stepsOf = (job) => job.split(/\n      - /).slice(1);
const secretsIn = (text) => new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));

test('the committed workflow is exactly what the generator writes, so the three slots cannot drift', () => {
  assert.equal(wf, renderSharedWorkflow());
  assert.equal(SLOTS, 3);
});

test('names, groups and artifact names carry only indices and slot-keyed tags', () => {
  assert.deepEqual(lintNeutralNames(wf), []);
  assert.deepEqual(lintNeutralNames(caller), []);
});

test('no step prints project data through an env value (C2)', () => {
  assert.deepEqual(lintEnvExpressions(wf), []);
  assert.deepEqual(lintEnvExpressions(caller), []);
});

// The point of the whole design: a job that runs project code references no repository token
// and no key that opens another project. Every secret a job references is loaded into the
// runner process, so this is the test that matters.
test('each job references only the secrets its trust tier allows, and a slot only its own key', () => {
  const trusted = { select: ['RUNNER_TOKENS', 'STORE_TOKEN', 'STORE_REPO', 'RUN_KEY'], continue: [] };
  for (let k = 0; k < SLOTS; k++) {
    trusted[`clone_${k}`] = ['RUNNER_TOKENS', 'RUN_KEY', `SLOT_KEY_${k}`];
    trusted[`publish_${k}`] = ['RUNNER_TOKENS', 'RUN_KEY', `SLOT_KEY_${k}`, 'STORE_REPO', 'STORE_TOKEN', 'PUBLISH_PRIVATE_KEY'];
  }
  const untrusted = {};
  for (let k = 0; k < SLOTS; k++) untrusted[`run_${k}`] = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_2', `SLOT_KEY_${k}`, 'PUBLISH_PUBLIC_KEY'];
  assert.deepEqual(Object.keys(jobs).sort(), [...Object.keys(trusted), ...Object.keys(untrusted)].sort());
  for (const [name, allowed] of Object.entries({ ...trusted, ...untrusted })) {
    for (const s of secretsIn(jobs[name])) assert.ok(allowed.includes(s), `${name} references ${s}`);
  }
  for (const name of Object.keys(untrusted)) {
    for (const forbidden of ['RUNNER_TOKENS', 'RUN_KEY', 'STORE_TOKEN', 'STORE_REPO', 'PUBLISH_PRIVATE_KEY']) {
      assert.ok(!jobs[name].includes(forbidden), `${name} must not mention ${forbidden}`);
    }
    for (let k = 0; k < SLOTS; k++) {
      if (name !== `run_${k}`) assert.ok(!jobs[name].includes(`SLOT_KEY_${k}`), `${name} must not mention another slot's key`);
    }
  }
});

test('the agent step is given the Claude tokens and nothing else secret', () => {
  for (let k = 0; k < SLOTS; k++) {
    const agent = stepsOf(jobs[`run_${k}`]).filter((s) => /run-task\.mjs/.test(s));
    assert.equal(agent.length, 1);
    assert.deepEqual([...secretsIn(agent[0])].sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_2']);
  }
});

test('every job asks for read access only, except the one that starts the next round', () => {
  for (const [name, job] of Object.entries(jobs)) {
    const perms = /permissions:\n((?:      +\w[\w-]*: \w+\n)+)/.exec(job)?.[1] ?? '';
    assert.ok(perms, `${name} states its permissions`);
    for (const line of perms.trim().split('\n')) {
      const [key, value] = line.trim().split(': ');
      if (name === 'continue' && key === 'actions') assert.equal(value, 'write');
      else assert.equal(value, 'read', `${name}: ${line.trim()}`);
    }
  }
});

test('three slots, each only when a task was chosen for it and select succeeded', () => {
  for (let k = 0; k < SLOTS; k++) {
    for (const part of ['clone', 'run', 'publish']) {
      const job = jobs[`${part}_${k}`];
      assert.match(job, new RegExp(`needs\\.select\\.result == 'success' && fromJSON\\(needs\\.select\\.outputs\\.count\\) > ${k}`), `${part}_${k}`);
    }
  }
  assert.match(jobs.continue, /needs\.select\.result == 'success'/);
});

test('the slots are identical apart from their index', () => {
  const norm = (k) => ['clone', 'run', 'publish'].map((p) => jobs[`${p}_${k}`]).join('\n')
    .replace(new RegExp(`\\b(clone|run|publish)_${k}\\b`, 'g'), '$1_K')
    .replace(new RegExp(`SLOT_KEY_${k}\\b`, 'g'), 'SLOT_KEY_K')
    .replace(new RegExp(`\\b(clone|run|publish) ${k}\\b`, 'g'), '$1 K')
    .replace(new RegExp(`count\\) > ${k}\\b`, 'g'), 'count) > K')
    .replace(new RegExp(`--index ${k}\\b`, 'g'), '--index K')
    .replace(new RegExp(`--slot ${k}\\b`, 'g'), '--slot K')
    .replace(new RegExp(`GITHUB_RUN_ATTEMPT:${k}"`, 'g'), 'GITHUB_RUN_ATTEMPT:K"');
  assert.equal(norm(1), norm(0));
  assert.equal(norm(2), norm(0));
  assert.ok(norm(0).includes('SLOT_KEY_K') && norm(0).includes('CLAUDE_CODE_OAUTH_TOKEN_2'), 'the shared secrets are left alone');
});

test('the run job meets its clone job through names only the slot can compute, and keeps its private key to itself', () => {
  for (let k = 0; k < SLOTS; k++) {
    const run = jobs[`run_${k}`];
    assert.match(run, /cli\.mjs keygen --out "\$RUNNER_TEMP\/keys"/);
    assert.match(run, /name: pub-\$\{\{ steps\.names\.outputs\.pub \}\}/);
    assert.match(run, /path: \$\{\{ runner\.temp \}\}\/pub\.txt/);
    assert.ok(!/path: .*private\.key/.test(run), 'the private key is never uploaded');
    const clone = jobs[`clone_${k}`];
    assert.match(clone, /wait-artifact\.sh pub /);
    assert.match(clone, /cli\.mjs seal /);
    assert.match(clone, /--allow-links/);
  }
});

test('the run output is sealed to the publish key, which the run job can only encrypt with', () => {
  for (let k = 0; k < SLOTS; k++) {
    const run = jobs[`run_${k}`];
    assert.match(run, /SEAL_PUBLIC_KEY: \$\{\{ secrets\.PUBLISH_PUBLIC_KEY \}\}/);
    assert.match(run, /cli\.mjs seal --dir "\$RUNNER_TEMP\/agent"/);
    assert.match(jobs[`publish_${k}`], /OPEN_PRIVATE_KEY: \$\{\{ secrets\.PUBLISH_PRIVATE_KEY \}\}/);
  }
});

test('every encrypt, decrypt, seal and open binds the file to its run and slot', () => {
  const lines = wf.split('\n').filter((l) => /cli\.mjs (encrypt|decrypt|seal|open) /.test(l));
  assert.ok(lines.length >= 1 + 3 * 5, `found ${lines.length}`);
  for (const l of lines) assert.match(l, /--aad "/, l);
});

test('handoff artifacts live one day; the output, which only the owner can open, three', () => {
  const retention = (job, label) => {
    const step = stepsOf(jobs[job]).find((s) => new RegExp(`name: ${label}-`).test(s));
    return /retention-days: (\d+)/.exec(step ?? '')?.[1];
  };
  for (let k = 0; k < SLOTS; k++) {
    assert.equal(retention(`run_${k}`, 'pub'), '1');
    assert.equal(retention(`clone_${k}`, 'bundle'), '1');
    assert.equal(retention(`run_${k}`, 'out'), '3');
  }
  assert.match(jobs.select, /name: selection-\$\{\{ github\.run_attempt \}\}\n\s+path: .*\n\s+retention-days: 1/);
});

test('publish decides from its own verified output and passes the verdict through the guard (review focus 4)', () => {
  assert.ok(!/needs\.run[_0-9]*\.result/.test(wf), 'a result aggregated over jobs says nothing about this project');
  for (let k = 0; k < SLOTS; k++) {
    const publish = stepsOf(jobs[`publish_${k}`]).find((s) => /Publish result/.test(s));
    assert.match(publish, /verdict\.json/);
    const guard = publish.indexOf('cli.mjs guard-verdict');
    const send = publish.indexOf('publish.sh');
    assert.ok(guard > 0 && guard < send, 'the guard runs before anything is published');
  }
});

test('publish.sh output and errors go to a file, never to the public log (review focus 5)', () => {
  for (let k = 0; k < SLOTS; k++) {
    const publish = stepsOf(jobs[`publish_${k}`]).find((s) => /Publish result/.test(s));
    assert.match(publish, /publish\.sh >"\$RUNNER_TEMP\/publish\.log" 2>&1/);
  }
});

test('the continue job needs only the right to start a workflow, after every publish', () => {
  assert.match(jobs.continue, /actions: write/);
  assert.ok(!/contents: write|issues: write|pull-requests: write/.test(jobs.continue));
  assert.match(jobs.continue, /needs: \[select, publish_0, publish_1, publish_2\]/);
});

test('the caller can only be started by the schedule or by the owner, and reacts to nothing else', () => {
  assert.match(caller, /^on:\n  workflow_dispatch:\n(?:  #.*\n)*  schedule:/m);
  assert.ok(!/^\s+(issues|pull_request|pull_request_target|issue_comment|push):/m.test(caller));
  assert.match(caller, /github\.event_name == 'schedule' \|\| github\.actor == github\.repository_owner \|\| github\.actor == 'github-actions\[bot\]'/);
});

test('the caller passes every secret the workflow declares', () => {
  const declared = [...wf.slice(0, wf.indexOf('\njobs:')).matchAll(/^      ([A-Z][A-Z0-9_]+):$/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 10, `declared ${declared.length}`);
  for (const name of declared) assert.match(caller, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`), name);
});

test('everything is bound to the run attempt: aad, names and proofs use run id and attempt together', () => {
  assert.ok(!/--aad "\$GITHUB_RUN_ID"/.test(wf) && !/--aad "\$GITHUB_RUN_ID:/.test(wf), 'no bare run id');
  assert.ok(!/--run-id "\$GITHUB_RUN_ID"/.test(wf));
  const aads = [...wf.matchAll(/--aad "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(aads.length >= 19);
  for (const a of aads) assert.match(a, /^\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT(:\d)?$/, a);
  for (const name of ['clone', 'run', 'publish']) assert.match(jobs[`${name}_0`], /selection-\$\{\{ github\.run_attempt \}\}|--run-id "\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"|--aad/);
  for (let k = 0; k < SLOTS; k++) {
    for (const part of ['clone', 'publish']) assert.match(jobs[`${part}_${k}`], /name: selection-\$\{\{ github\.run_attempt \}\}/);
  }
});

test('the run job publishes its public key, with a proof, before it installs anything slow (shrinks the forgery window)', () => {
  for (let k = 0; k < SLOTS; k++) {
    const run = jobs[`run_${k}`];
    const pub = run.indexOf('name: pub-');
    assert.ok(pub > 0 && pub < run.indexOf('Install tooling'), 'the public key goes up first');
    assert.ok(run.includes(`cli.mjs proof --run-id "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --slot ${k} --label pub --data-file`), 'the public key is signed with this slot\'s key');
  }
});

test('every handoff is authenticated by content, not only by name: pub, bundle and out each carry a slot proof that is checked before use (review C2)', () => {
  for (let k = 0; k < SLOTS; k++) {
    const clone = jobs[`clone_${k}`];
    const run = jobs[`run_${k}`];
    const publish = jobs[`publish_${k}`];
    // clone checks the public key's proof before it seals anything to it, and signs the bundle
    assert.ok(clone.indexOf('cli.mjs proof-check --run-id') > 0 && clone.indexOf('--label pub') > 0);
    assert.ok(clone.indexOf('proof-check') < clone.indexOf('cli.mjs seal '), 'verify, then seal');
    assert.match(clone, /cli\.mjs proof --run-id[^\n]*--label bundle/);
    assert.ok(clone.indexOf('--label bundle') < clone.indexOf('cli.mjs seal '), 'the bundle proof is inside the sealed bundle');
    // run checks the bundle's proof before it runs anything, and signs its output
    assert.ok(run.indexOf('proof-check') > 0 && run.indexOf('--label bundle') > 0);
    assert.ok(run.indexOf('proof-check') < run.indexOf('Run task'), 'verify the bundle before running it');
    assert.match(run, /cli\.mjs proof --run-id[^\n]*--label out/);
    assert.ok(run.lastIndexOf('--label out') < run.indexOf('cli.mjs seal --dir "$RUNNER_TEMP/agent"'), 'the output proof is inside the sealed output');
    // publish checks the output's proof before it trusts anything in it
    assert.ok(publish.indexOf('proof-check') > 0 && publish.indexOf('--label out') > 0);
    assert.ok(publish.indexOf('proof-check') < publish.indexOf('guard-verdict'), 'verify the output before the guard reads it');
  }
});

test('every action the trusted jobs run is pinned to a commit, not a tag that can move (review L4)', () => {
  const uses = [...wf.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 4 * 3);
  for (const u of uses) assert.match(u, /^actions\/[a-z-]+@[0-9a-f]{40}$/, u);
  assert.equal(new Set(uses).size, 4, 'checkout, setup-node, upload-artifact, download-artifact');
});
