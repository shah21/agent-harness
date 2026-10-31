import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'harness', 'wait-artifact.sh');
const CLI = join(import.meta.dirname, '..', 'harness', 'cli.mjs');
const SLOT_KEY = 'a-long-enough-slot-secret-0001';
const haveZip = spawnSync('zip', ['-v']).status === 0;
const tmp = () => mkdtempSync(join(tmpdir(), 'wait-'));

// A gh stand-in: lists the artifact only from the Nth poll on, and serves a zip for the download.
function stubGh(stateDir) {
  const bin = tmp();
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${stateDir}/calls.log"
case "$*" in
  *"/zip"*) cat "${stateDir}/artifact.zip" ;;
  *"artifacts?name="*)
    n=$(cat "${stateDir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${stateDir}/count"
    if [ "$n" -ge "\${STUB_AFTER:-1}" ]; then echo 4242; fi ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}
function setup(content = 'PUBLIC-KEY-BYTES\n') {
  const state = tmp();
  const src = join(state, 'public.key');
  writeFileSync(src, content);
  spawnSync('zip', ['-q', '-j', join(state, 'artifact.zip'), src]);
  return { state, bin: stubGh(state) };
}
const run = ({ state, bin }, args, env = {}) => {
  const out = join(state, 'out.bin');
  const r = spawnSync('bash', [SCRIPT, ...args(out)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'tok', GITHUB_REPOSITORY: 'runner/repo', GITHUB_RUN_ID: '777', SLOT_KEY, WAIT_INTERVAL: '0.1', ...env },
  });
  return { ...r, out, calls: existsSync(join(state, 'calls.log')) ? readFileSync(join(state, 'calls.log'), 'utf8') : '' };
};
const tagOf = (label) => spawnSync('node', [CLI, 'tag', '--run-id', '777', '--label', label], { encoding: 'utf8', env: { ...process.env, SLOT_KEY } }).stdout.trim();

test('waits for the artifact named by this slot\'s tag, downloads it and prints nothing', { skip: !haveZip }, () => {
  const s = setup();
  const r = run(s, (out) => ['pub', out, '30'], { STUB_AFTER: '3' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(readFileSync(r.out, 'utf8'), 'PUBLIC-KEY-BYTES\n');
  const polls = r.calls.split('\n').filter((l) => l.includes('artifacts?name='));
  assert.equal(polls.length, 3);
  for (const l of polls) assert.ok(l.includes(`name=pub-${tagOf('pub')}`), l);
  assert.ok(r.calls.includes('repos/runner/repo/actions/artifacts/4242/zip'));
  assert.ok(r.calls.includes('repos/runner/repo/actions/runs/777/artifacts'), 'only this run\'s artifacts are listed');
});

test('a label gives a different name, so one slot cannot be fed another slot\'s handoff', { skip: !haveZip }, () => {
  const s = setup();
  const r = run(s, (out) => ['bundle', out, '30']);
  assert.ok(r.calls.includes(`name=bundle-${tagOf('bundle')}`));
  assert.notEqual(tagOf('bundle'), tagOf('pub'));
});

test('on timeout it fails with a fixed message that names nothing', { skip: !haveZip }, () => {
  const s = setup();
  const r = run(s, (out) => ['pub', out, '1'], { STUB_AFTER: '9999' });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'handoff timed out\n');
  assert.ok(!existsSync(r.out));
  assert.ok(!r.stdout.includes(tagOf('pub')) && !r.stderr.includes(SLOT_KEY));
});

test('an artifact that is not exactly one file is refused', { skip: !haveZip }, () => {
  const state = tmp();
  writeFileSync(join(state, 'a'), '1');
  writeFileSync(join(state, 'b'), '2');
  spawnSync('zip', ['-q', '-j', join(state, 'artifact.zip'), join(state, 'a'), join(state, 'b')]);
  const r = run({ state, bin: stubGh(state) }, (out) => ['pub', out, '5']);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'handoff was not a single file\n');
  assert.ok(!existsSync(r.out));
});

test('missing configuration fails before any request', () => {
  const s = setup();
  const r = run(s, (out) => ['pub', out, '5'], { SLOT_KEY: '' });
  assert.equal(r.status, 1);
  assert.equal(r.calls, '');
});
