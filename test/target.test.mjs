import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANCH_RE, RELATED_TOKEN, splitTaskType, slugify, fill, renderBranch,
  parseGitmodules, targetsMarker, parseTargetsMarker, latestTargets, targetPromptSection,
} from '../harness/lib/target.mjs';

test('splitTaskType reads a conventional-commit prefix and defaults to fix', () => {
  assert.deepEqual(splitTaskType('feat: Add picker'), { type: 'feat', title: 'Add picker' });
  assert.deepEqual(splitTaskType('perf:  Faster list'), { type: 'perf', title: 'Faster list' });
  assert.deepEqual(splitTaskType('Add picker'), { type: 'fix', title: 'Add picker' });
  assert.deepEqual(splitTaskType('wip: thing'), { type: 'fix', title: 'wip: thing' });
});

test('slugify lowercases, dashes and trims to 50 chars', () => {
  assert.equal(slugify('Add `picker` to Query Panel!'), 'add-picker-to-query-panel');
  assert.equal(slugify('x'.repeat(60)), 'x'.repeat(50));
  assert.equal(slugify(`${'a'.repeat(49)} b`), 'a'.repeat(49));
});

test('renderBranch fills the template', () => {
  const t = { issue: 12, task: 3, taskTitle: 'feat: Add picker' };
  assert.equal(renderBranch('{type}/{slug}', t), 'feat/add-picker');
  assert.equal(renderBranch('agent/issue-{issue}', t), 'agent/issue-12');
  assert.equal(renderBranch('{type}/t{task}-{slug}', { ...t, taskTitle: 'Fix crash' }), 'fix/t3-fix-crash');
});

test('renderBranch rejects unknown variables and unsafe names', () => {
  const t = { issue: 1, task: 1, taskTitle: 'x' };
  assert.throws(() => renderBranch('{nope}/{slug}', t), /branch template uses unknown variable \{nope\}/);
  assert.throws(() => renderBranch('{type}/{slug}', { ...t, taskTitle: '!!!' }), /branch name "fix\/" is not allowed/);
  assert.throws(() => renderBranch('Fix/{slug}', t), /is not allowed/);
  assert.throws(() => renderBranch('a..b/{slug}', t), /is not allowed/);
  assert.throws(() => renderBranch('{slug}.lock', t), /is not allowed/);
  assert.ok(BRANCH_RE.test('feat/add-picker'));
});

test('fill replaces known variables once and rejects unknown ones', () => {
  assert.equal(fill('{summary} / {task}', { summary: 'S {task}', task: '3' }), 'S {task} / 3');
  assert.throws(() => fill('{x}', {}), /template uses unknown variable \{x\}/);
});

test('parseGitmodules reads path and GitHub repo, ignoring other keys', () => {
  const text = '[submodule "packages/ui"]\n\tpath = packages/ui\n\turl = https://github.com/o/ui.git\n    branch = stable\n[submodule "packages/core"]\n\tpath = packages/core\n\turl = https://github.com/o/core\n';
  assert.deepEqual(parseGitmodules(text), [
    { path: 'packages/ui', repo: 'o/ui' },
    { path: 'packages/core', repo: 'o/core' },
  ]);
  assert.deepEqual(parseGitmodules(''), []);
});

test('parseGitmodules rejects non-GitHub URLs and escaping paths', () => {
  assert.throws(() => parseGitmodules('[submodule "a"]\npath = a\nurl = git@github.com:o/a.git\n'), /unsupported submodule URL "git@github\.com:o\/a\.git"/);
  assert.throws(() => parseGitmodules('[submodule "a"]\npath = ../a\nurl = https://github.com/o/a.git\n'), /submodule path "\.\.\/a" must be relative/);
  assert.throws(() => parseGitmodules('[submodule "a"]\npath = a\n'), /\.gitmodules entry without path or url/);
});

const prs = [
  { repo: 'o/sub', number: 45, branch: 'fix/x', base: 'main', role: 'sub' },
  { repo: 'o/super', number: 123, branch: 'fix/x', base: 'main', role: 'super' },
];

test('targets marker round-trips', () => {
  const m = targetsMarker(prs);
  assert.match(m, /^<!-- agent-targets \{"prs":\[.*\]\} -->$/);
  assert.deepEqual(parseTargetsMarker(`text\n\n${m}\n`), prs);
  assert.equal(parseTargetsMarker('no marker'), null);
});

test('rejects unsafe markers', () => {
  const bad = (p) => parseTargetsMarker(targetsMarker([{ ...prs[0], ...p }]));
  assert.equal(bad({ branch: 'x; rm -rf /' }), null);
  assert.equal(bad({ role: 'admin' }), null);
  assert.equal(bad({ repo: 'not a repo' }), null);
  assert.equal(bad({ number: '45' }), null);
  assert.equal(parseTargetsMarker('<!-- agent-targets {"prs":[ -->'), null);
  assert.equal(parseTargetsMarker('<!-- agent-targets {"nope":1} -->'), null);
});

test('latestTargets reads only the most recent READY comment', () => {
  const ready = (p) => ({ body: `✅ **READY_FOR_QA** — url\n\n${targetsMarker(p)}` });
  const older = [{ ...prs[0], number: 1 }];
  assert.deepEqual(latestTargets([ready(older), { body: 'a human comment' }, ready(prs)]), prs);
  assert.equal(latestTargets([ready(prs), { body: '✅ **READY_FOR_QA** — url' }]), null);
  assert.equal(latestTargets([]), null);
  assert.equal(latestTargets(undefined), null);
});

test('target prompt section names the path, repo and branch', () => {
  const s = targetPromptSection({ path: 'target', repo: 'o/super', branch: 'fix/x' });
  assert.match(s, /## Target repository/);
  assert.match(s, /`target`, a clone of `o\/super`/);
  assert.match(s, /branch `fix\/x`/);
  assert.match(s, /Do not push/);
  assert.equal(RELATED_TOKEN, '<!-- agent-related -->');
});
