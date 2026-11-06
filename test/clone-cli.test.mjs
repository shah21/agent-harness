import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = join(import.meta.dirname, '..', 'harness', 'cli.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'clonecli-'));
const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
const entryWith = (target, selection = {}) => ({
  index: 0, repo: 'a/one', selection: { issue: { number: 3 }, plan: 'docs/p.md', task: 2, base: 'main', skip: null, ...selection }, target,
});

test('submodule-plan lists the paths when every submodule is on the owner\'s allow-list, ignoring case', () => {
  const dir = tmp();
  const entry = join(dir, 'entry.json');
  writeFileSync(entry, JSON.stringify(entryWith({ repo: 'org/code', allow: ['org/Sub-A', 'org/sub-b'] })));
  const mods = join(dir, '.gitmodules');
  writeFileSync(mods, '[submodule "a"]\n\tpath = frontend/ee\n\turl = https://github.com/org/sub-a.git\n[submodule "b"]\n\tpath = server/ee\n\turl = https://github.com/ORG/Sub-B\n');
  const r = run(['submodule-plan', '--entry', entry, '--gitmodules', mods]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'frontend/ee\nserver/ee\n');
});

test('one submodule that is not allowed, not on github over https, or has a path that climbs, fails the whole plan', () => {
  const dir = tmp();
  const entry = join(dir, 'entry.json');
  writeFileSync(entry, JSON.stringify(entryWith({ repo: 'org/code', allow: ['org/sub-a'] })));
  const ok = '[submodule "a"]\n\tpath = a\n\turl = https://github.com/org/sub-a.git\n';
  for (const bad of [
    '[submodule "x"]\n\tpath = x\n\turl = https://github.com/victim/private.git\n',
    '[submodule "x"]\n\tpath = x\n\turl = file:///etc\n',
    '[submodule "x"]\n\tpath = x\n\turl = git@github.com:org/sub-a.git\n',
    '[submodule "x"]\n\tpath = ../x\n\turl = https://github.com/org/sub-a.git\n',
    '[submodule "x"]\n\tpath = x\n\turl = https://github.com/org/sub-a-evil.git\n',
  ]) {
    const mods = join(dir, '.gitmodules');
    writeFileSync(mods, ok + bad);
    const r = run(['submodule-plan', '--entry', entry, '--gitmodules', mods]);
    assert.equal(r.status, 1, bad);
    assert.equal(r.stdout, '', 'nothing is listed when anything is refused');
    assert.equal(r.stderr, 'submodule not allowed\n');
  }
});

test('with no allow-list, any submodule is refused; no .gitmodules entries means an empty plan', () => {
  const dir = tmp();
  const entry = join(dir, 'entry.json');
  writeFileSync(entry, JSON.stringify(entryWith({ repo: 'org/code', allow: [] })));
  const mods = join(dir, '.gitmodules');
  writeFileSync(mods, '[submodule "a"]\n\tpath = a\n\turl = https://github.com/org/sub-a.git\n');
  assert.equal(run(['submodule-plan', '--entry', entry, '--gitmodules', mods]).status, 1);
  writeFileSync(mods, '');
  const empty = run(['submodule-plan', '--entry', entry, '--gitmodules', mods]);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, '');
});
