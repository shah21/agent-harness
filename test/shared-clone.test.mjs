import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'harness', 'shared-clone.sh');
const tmp = () => mkdtempSync(join(tmpdir(), 'clone-'));

// A git stand-in: records its arguments, creates what a clone or submodule update would create
// (a directory, and a .gitmodules when told to) and, when told to fail, behaves like real git by
// printing the repository URL to stderr.
function stubGit({ failOn, gitmodules, nested } = {}) {
  const dir = tmp();
  const log = join(dir, 'calls.log');
  const envLog = join(dir, 'env.log');
  writeFileSync(join(dir, 'git'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
printf '%s\\n' "ALLOW=$GIT_ALLOW_PROTOCOL PROMPT=$GIT_TERMINAL_PROMPT" >> "${envLog}"
if [ -n "${failOn ?? ''}" ] && [[ "$*" == *"${failOn ?? ''}"* ]]; then
  echo "fatal: repository 'https://github.com/zzsecret/name.git/' not found" >&2
  exit 128
fi
case " $* " in
  *" clone "*)
    dest="\${@: -1}"
    mkdir -p "$dest"
    if [[ "$dest" == */target ]]; then printf '%s' '${(gitmodules ?? '').replaceAll("'", "'\''")}' > "$dest/.gitmodules"; fi
    ;;
  *" submodule update "*)
    where=""; prev=""
    for a in "$@"; do if [ "$prev" = "-C" ]; then where="$a"; fi; prev="$a"; done
    path="\${@: -1}"
    mkdir -p "$where/$path"
    if [ "$path" = "frontend/ee" ]; then printf '%s' '${(nested ?? '').replaceAll("'", "'\''")}' > "$where/$path/.gitmodules"; fi
    ;;
esac
exit 0
`);
  chmodSync(join(dir, 'git'), 0o755);
  return { dir, log, envLog };
}

const entry = (extra = {}) => ({
  repo: 'zzsecret/name', tokenOwner: 'alice', tokenIndex: 1,
  selection: { base: 'agent/issue-3' }, target: null, ...extra,
});
const run = (stub, entryObj, tokens = { alice: ['github_pat_zzfirst', 'ghp_zzsecondtoken'], org: ['ghp_zzorgtoken'] }) => {
  const work = tmp();
  const entryFile = join(work, 'entry.json');
  writeFileSync(entryFile, JSON.stringify(entryObj));
  const r = spawnSync('bash', [SCRIPT, entryFile, join(work, 'project')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stub.dir}:${process.env.PATH}`, RUNNER_TOKENS: JSON.stringify(tokens) },
  });
  return { ...r, work, calls: existsSync(stub.log) ? readFileSync(stub.log, 'utf8') : '' };
};

test('the resolved token goes in a one-command header, never in a URL', () => {
  const stub = stubGit();
  const r = run(stub, entry());
  assert.equal(r.status, 0, r.stderr);
  const lines = r.calls.trim().split('\n');
  assert.equal(lines.length, 2, 'clone and checkout');
  const b64 = Buffer.from('x-access-token:ghp_zzsecondtoken').toString('base64');
  for (const l of lines) assert.ok(l.includes(`http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`), l);
  assert.ok(lines[0].includes('clone -q --no-checkout https://github.com/zzsecret/name.git'));
  assert.ok(!r.calls.includes('ghp_zzsecondtoken'), 'the raw token is not in any git argument');
  assert.ok(lines[1].endsWith('checkout -q agent/issue-3'));
  assert.ok(!/ghp_zzfirst|github_pat_zzfirst/.test(r.calls), 'only the resolved token is used');
});

test('the log gets mask commands for the token and its encoded form, and nothing else', () => {
  const r = run(stubGit(), entry());
  const b64 = Buffer.from('x-access-token:ghp_zzsecondtoken').toString('base64');
  assert.equal(r.stdout, `::add-mask::ghp_zzsecondtoken\n::add-mask::${b64}\n`);
  assert.equal(r.stderr, '');
});

test('a failing git leaks neither the repository nor the token: only a fixed message', () => {
  const stub = stubGit({ failOn: 'clone' });
  const r = run(stub, entry());
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'clone failed\n');
  assert.ok(!/zzsecret|ghp_zz/.test(r.stderr));
});

const SUB_A = '[submodule "a"]\n\tpath = frontend/ee\n\turl = https://github.com/org/sub-a.git\n';
const target = (extra = {}) => ({ repo: 'org/code', path: 'target', ref: 'agent/issue-2', tokenOwner: 'org', tokenIndex: 0, tokenKind: 'classic', allow: ['org/sub-a'], branchTemplate: '{type}/{slug}', branchPrefixes: [], ...extra });

test('a target is cloned with its own token at its ref, and only allowed submodules are initialised', () => {
  const stub = stubGit({ gitmodules: SUB_A });
  const r = run(stub, entry({ target: target() }));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.calls.trim().split('\n');
  assert.equal(lines.length, 5, 'project: clone + checkout; target: clone + checkout + one submodule');
  const orgB64 = Buffer.from('x-access-token:ghp_zzorgtoken').toString('base64');
  for (const l of lines.slice(2)) assert.ok(l.includes(orgB64), l);
  assert.ok(lines[2].includes('https://github.com/org/code.git'));
  assert.ok(lines[3].endsWith('checkout -q agent/issue-2'));
  assert.ok(lines[4].endsWith('submodule update -q --init -- frontend/ee'));
});

test('a submodule that is not allowed removes the target checkout and notes it, initialising nothing (confused deputy)', () => {
  const stub = stubGit({ gitmodules: `${SUB_A}[submodule "v"]\n\tpath = v\n\turl = https://github.com/victim/private.git\n` });
  const r = run(stub, entry({ target: target() }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.includes('submodule update'), 'nothing was initialised, not even the allowed one');
  assert.equal(readFileSync(join(r.work, 'target-checkout.txt'), 'utf8'), 'target checkout failed\n');
  assert.ok(!existsSync(join(r.work, 'project', 'target')), 'a partial target checkout is not left for the run');
  assert.ok(!/victim|zzsecret|ghp_zz/.test(r.stdout.replace(/::add-mask::.*\n/g, '') + r.stderr));
});

test('a nested submodule is checked at every depth', () => {
  const nestedBad = '[submodule "n"]\n\tpath = deeper\n\turl = https://github.com/victim/private.git\n';
  const r = run(stubGit({ gitmodules: SUB_A, nested: nestedBad }), entry({ target: target() }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(r.work, 'target-checkout.txt')));
  assert.ok(!existsSync(join(r.work, 'project', 'target')));
  const nestedOk = '[submodule "n"]\n\tpath = deeper\n\turl = https://github.com/org/sub-a.git\n';
  const ok = run(stubGit({ gitmodules: SUB_A, nested: nestedOk }), entry({ target: target() }));
  assert.ok(!existsSync(join(ok.work, 'target-checkout.txt')));
  assert.ok(ok.calls.includes('-- deeper'));
});

test('git is limited to https and never prompts', () => {
  const stub = stubGit({ gitmodules: SUB_A });
  run(stub, entry({ target: target() }));
  const seen = new Set(readFileSync(stub.envLog, 'utf8').trim().split('\n'));
  assert.deepEqual([...seen], ['ALLOW=https PROMPT=0']);
});

test('a target without a usable token is not cloned; a missing token fails cleanly', () => {
  const noToken = run(stubGit(), entry({ target: { error: 'no usable token' } }));
  assert.equal(noToken.status, 0);
  assert.equal(noToken.calls.trim().split('\n').length, 2, 'only the project');
  const missing = run(stubGit(), entry({ tokenIndex: 7 }));
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, 'clone failed\n');
});

test('a target that cannot be cloned is noted for the run, not fatal to the project clone (M5)', () => {
  const stub = stubGit({ failOn: 'org/code' });
  const r = run(stub, entry({ target: target({ ref: '' }) }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(r.work, 'target-checkout.txt'), 'utf8'), 'target checkout failed\n');
  assert.ok(!/zzsecret|ghp_zz/.test(r.stdout.replace(/::add-mask::.*\n/g, '') + r.stderr));
});
