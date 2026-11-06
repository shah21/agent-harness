import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// These run the real git: the point is that the allow-list is applied to what git itself will
// fetch, not to what a hand-written parser thinks the file says.
const CLI = join(import.meta.dirname, '..', 'harness', 'cli.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'subs-'));
const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
const entry = (allow) => {
  const f = join(tmp(), 'entry.json');
  writeFileSync(f, JSON.stringify({ selection: { issue: { number: 1 } }, target: { repo: 'org/code', allow } }));
  return f;
};
const mods = (text) => {
  const f = join(tmp(), '.gitmodules');
  writeFileSync(f, text);
  return f;
};
const plan = (text, allow = ['org/sub-a']) => run(['submodule-plan', '--entry', entry(allow), '--gitmodules', mods(text)]);

const GOOD = '[submodule "a"]\n\tpath = a\n\turl = https://github.com/org/sub-a.git\n';

test('a plain allowed submodule is planned', () => {
  const r = plan(GOOD);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'a\n');
});

test('forms that git reads differently from a hand-written parser cannot smuggle in another repository (review C1)', () => {
  const victim = 'https://github.com/victim/private';
  const attacks = {
    'section name in another case': `${GOOD}[Submodule "b"]\n\tpath = b\n\tURL = ${victim}\n`,
    'a second url key overriding the first': `[submodule "a"]\n\tpath = a\n\turl = https://github.com/org/sub-a\n\tURL = ${victim}\n`,
    'a comment after the header': `[submodule "a"] ; note\n\tpath = a\n\turl = ${victim}\n`,
    'upper-case keys': `[submodule "a"]\n\tPATH = a\n\tUrl = ${victim}\n`,
    'a second path key': `${GOOD}[submodule "c"]\n\tpath = c\n\tpath = d\n\turl = https://github.com/org/sub-a\n`,
    'a missing url': '[submodule "a"]\n\tpath = a\n',
    'a missing path': '[submodule "a"]\n\turl = https://github.com/org/sub-a\n',
    'an include directive': `${GOOD}[include]\n\tpath = /etc/hosts\n`,
  };
  for (const [name, text] of Object.entries(attacks)) {
    const r = plan(text);
    assert.equal(r.status, 1, name);
    assert.equal(r.stdout, '', `${name}: nothing is listed when anything is refused`);
    assert.equal(r.stderr, 'submodule not allowed\n', name);
  }
});

test('the real git sees exactly the URLs the plan checked: a registered submodule URL outside the list is refused (second layer)', () => {
  const repo = tmp();
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, '.gitmodules'), `[submodule "a"]\n\tpath = a\n\turl = https://github.com/org/sub-a\n[Submodule "b"]\n\tpath = b\n\tURL = https://github.com/victim/private\n`);
  mkdirSync(join(repo, 'b'));
  git('add', '.gitmodules');
  const sha = '1'.repeat(40);
  git('update-index', '--add', '--cacheinfo', '160000', sha, 'b');
  git('commit', '-q', '-m', 'x');

  // What a parser that only knows the exact header spelling would plan:
  git('submodule', 'init', '--', 'b');
  const verify = run(['submodule-verify', '--entry', entry(['org/sub-a']), '--repo-dir', repo]);
  assert.equal(verify.status, 1, 'git registered the victim URL, and the check sees it');
  assert.equal(verify.stderr, 'submodule not allowed\n');
  assert.ok(!/victim/.test(verify.stdout + verify.stderr));

  const other = tmp();
  execFileSync('git', ['-C', other, 'init', '-q']);
  writeFileSync(join(other, '.gitmodules'), GOOD);
  execFileSync('git', ['-C', other, 'config', 'submodule.a.url', 'https://github.com/org/sub-a.git']);
  const ok = run(['submodule-verify', '--entry', entry(['org/sub-a']), '--repo-dir', other]);
  assert.equal(ok.status, 0, ok.stderr);
});

test('the submodule URLs git registers must be github https, on the list, ignoring case and a .git suffix', () => {
  for (const [url, expected] of [
    ['https://github.com/ORG/Sub-A', 0], ['https://github.com/org/sub-a.git/', 0], ['https://github.com/org/sub-a-evil', 1],
    ['file:///etc', 1], ['git@github.com:org/sub-a.git', 1], ['https://user@github.com/org/sub-a', 1], ['http://github.com/org/sub-a', 1],
    ['https://github.com:444/org/sub-a', 1], ['https://github.com.evil.example/org/sub-a', 1],
  ]) {
    const repo = tmp();
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'config', 'submodule.a.url', url]);
    assert.equal(run(['submodule-verify', '--entry', entry(['org/sub-a']), '--repo-dir', repo]).status, expected, url);
  }
});

test('paths that climb, start with a dash or are absolute are refused, and an empty list means no submodules at all', () => {
  for (const path of ['../x', '/abs', '-flag', 'a//b', 'a/./b', 'a/..']) {
    const r = plan(`[submodule "a"]\n\tpath = ${path}\n\turl = https://github.com/org/sub-a\n`);
    assert.equal(r.status, 1, path);
  }
  assert.equal(plan(GOOD, []).status, 1);
  const empty = plan('');
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, '');
});
