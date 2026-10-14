import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { copySkill, planGoal, changedHunks } from '../harness/lib/review-inputs.mjs';

const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function repo({ base = {}, head = {}, remove = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'review-skill-'));
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [p, t] of Object.entries(base)) write(dir, p, t);
  git('add', '-A');
  git('commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  for (const [p, t] of Object.entries(head)) write(dir, p, t);
  for (const p of remove) rmSync(join(dir, p));
  git('add', '-A');
  git('commit', '-qm', 'head', '--allow-empty');
  return { prefix: '', dir, base: sha, branch: 'main' };
}

const out = () => join(mkdtempSync(join(tmpdir(), 'review-skill-out-')), 'review-skill');

test('the skill is copied at base, references included', () => {
  const r = repo({
    base: { 'skills/rev/SKILL.md': 'Base skill\n', 'skills/rev/references/lenses.md': 'Lenses\n', 'other.md': 'x\n' },
    head: { 'skills/rev/SKILL.md': 'Changed by the agent\n', 'skills/rev/extra.md': 'new\n' },
  });
  const dest = out();
  assert.deepEqual(copySkill([r], 'skills/rev', dest), { files: ['SKILL.md', 'references/lenses.md'] });
  assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'Base skill\n');
  assert.equal(readFileSync(join(dest, 'references', 'lenses.md'), 'utf8'), 'Lenses\n');
  assert.equal(existsSync(join(dest, 'extra.md')), false);
});

test('a skill that exists only on the branch is not found', () => {
  const r = repo({ base: { 'a.txt': 'a\n' }, head: { 'skills/rev/SKILL.md': 'New\n' } });
  assert.deepEqual(copySkill([r], 'skills/rev', out()), { error: 'review skill not found: skills/rev/SKILL.md' });
});

test('a skill in a prefixed repository', () => {
  const consumer = repo({ base: { 'a.txt': 'a\n' } });
  const target = { ...repo({ base: { 'skills/rev/SKILL.md': 'Target skill\n' } }), prefix: 'target/' };
  const dest = out();
  assert.deepEqual(copySkill([consumer, target], 'target/skills/rev', dest), { files: ['SKILL.md'] });
  assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'Target skill\n');
});

test('a skill over 1 MB is refused', () => {
  const r = repo({ base: { 'skills/rev/SKILL.md': 'x\n', 'skills/rev/big.md': 'y'.repeat(1024 * 1024 + 1) } });
  assert.deepEqual(copySkill([r], 'skills/rev', out()), { error: 'review skill is larger than 1 MB: skills/rev' });
});

test('plan goal is the text before the first task', () => {
  assert.equal(planGoal('# Plan\n\n**Goal:** Parse ages.\n\n## Task 1: feat: x\n\nDo x.\n'), '# Plan\n\n**Goal:** Parse ages.');
  assert.equal(planGoal('# Plan\n\nNo tasks.\n'), '# Plan\n\nNo tasks.');
});

test('changed hunks give new-file line ranges', () => {
  const r = repo({
    base: { 'a.txt': '1\n2\n3\n4\n5\n', 'gone.txt': 'g\n', 'cut.txt': '1\n2\n3\n' },
    head: { 'a.txt': '1\nTWO\n3\n4\n5\n6\n', 'new.txt': 'n1\nn2\n', 'cut.txt': '1\n3\n' },
    remove: ['gone.txt'],
  });
  const hunks = changedHunks([r]);
  assert.deepEqual(hunks.get('a.txt'), [[2, 2], [6, 6]]);
  assert.deepEqual(hunks.get('new.txt'), [[1, 2]]);
  assert.deepEqual(hunks.get('cut.txt'), [[1, 1]]);
  assert.equal(hunks.has('gone.txt'), false);
});

test('changed hunks carry the repository prefix', () => {
  const r = { ...repo({ base: { 'a.txt': 'a\n' }, head: { 'a.txt': 'b\n' } }), prefix: 'target/' };
  assert.deepEqual([...changedHunks([r]).entries()], [['target/a.txt', [[1, 1]]]]);
});
