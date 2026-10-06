# Target Repositories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A consumer can set `"target"` in `agent.config.json` so a task changes a separate superproject and its submodules, published as one draft PR per changed repository, while consumers without `"target"` behave exactly as before.

**Architecture:** Pure helpers (branch template, `.gitmodules`, targets marker) go in `harness/lib/target.mjs`; git side effects on the target clone go in `harness/lib/target-run.mjs`; `run-task.mjs` calls them only when `config.target` is set. The workflow clones the target in the run job with a read token in one step, `run-task.mjs` writes thin per-repository bundles into the run artifact, and a new `harness/publish-targets.mjs` pushes them and opens draft PRs in the publish job. The issue comment carries an `agent-targets` marker that the select job reads for stacking and close-on-merge.

**Tech Stack:** Node ≥ 22, ES modules, `node:test`, bash, GitHub Actions, `gh`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-target-repos-design.md`

**Execution:** Tasks 2–10 run as agent tasks (one issue each, label `agent`). Task 1 was done during setup, together with connecting this repository to the harness. Task 11 changes `.github/**`, which the harness protects, so it is done by hand. Task 12 is a manual release.

## Global Constraints

- No new dependencies; Node built-ins only.
- **Compatibility:** every new behaviour is gated on `config.target` (run) or on `verdict.targets` / a targets marker (publish, select). Existing tests in `test/*.test.mjs` are never edited; new cases are appended or go in new files. `test/compat.test.mjs` (Task 1) must pass after every task.
- Branch names: `^[a-z0-9][a-z0-9._/-]{0,99}$`, no `..`, not ending in `/` or `.lock`. Template variables `{slug}`, `{type}`, `{issue}`, `{task}`; default template `agent/issue-{issue}`.
- `{type}` ∈ `feat fix chore refactor test docs perf`, read from a `<type>: ` prefix of the task title; default `fix`. `{slug}`: lowercase, non-alphanumerics → `-`, trimmed, at most 50 chars.
- PR templates: title default `Task {task}: {taskTitle}`; variables `{issue} {task} {taskTitle} {summary} {changedFiles} {checks} {related}`. `{related}` is filled at publish time.
- Marker, verbatim shape: `<!-- agent-targets {"prs":[{"repo":"o/n","number":1,"branch":"b","base":"main","role":"sub"}]} -->`, `role` ∈ `sub`, `super`.
- Secrets `TARGET_READ_TOKEN` (run job clone step only) and `TARGET_PUSH_TOKEN` (select and publish jobs only). Neither ever enters the agent's environment.
- Blocked reasons, verbatim: `target configured but TARGET_READ_TOKEN or TARGET_PUSH_TOKEN secret missing` (harness), `target checkout failed` (harness), `target path "<p>" is not git-ignored` (harness), `PR body template not found: <p>` (harness), `submodule <path> changed but the superproject does not point at it` (gate), `agent switched <path> to branch "<b>"; work must stay on <branch>` (gate).
- Nothing is pushed to target repositories unless the outcome is `READY_FOR_QA`.

## Review Focus

- **The target clone is git-ignored, so the pre-verification `git clean -ffdX` would delete it.** Expected: the clone survives and verification sees the agent's commits. (Task 7 test `target clone survives the verification clean`.)
- **A token leaking into the agent's process.** Expected: `TARGET_*` variables in the harness environment never reach the agent. (Task 7 test `target tokens never reach the agent`; Task 11 test `the Run task step carries no target secret`.)
- **A forged or edited targets marker in an issue comment** (branch `x; rm -rf /`, unknown role, broken JSON). Expected: ignored, never used as a base or ref. (Task 2 test `rejects unsafe markers`; Task 6 test `ignores a parent whose marker is unsafe`.)
- **A publish that fails halfway** (first PR opened, second fails). Expected: the issue ends `agent:blocked` and the comment lists the PR that was opened. (Task 10 test `a failure after one PR lists the opened PR`.)
- **A retried task whose PR already exists.** Expected: the branch is force-pushed and the existing PR is edited, not duplicated. (Task 10 test `an existing PR is edited, not duplicated`.)

---

## Task 1: Compatibility golden test

_Done during setup (`test/compat.test.mjs`, `test/golden/no-target.json`). `test/golden/**` is a protected path in `agent.config.json`: an agent task can never re-record it._

Locks today's observable output for a target-less consumer before anything changes.

**Files:**
- Create: `test/compat.test.mjs`
- Create: `test/golden/no-target.json` (generated)

**Interfaces:**
- Produces: `UPDATE_GOLDEN=1 node --test test/compat.test.mjs` rewrites the golden file; without it the test compares.

- [ ] **Step 1: Write the test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTask } from '../harness/run-task.mjs';
import { renderPrBody, renderComment } from '../harness/lib/format.mjs';
import { selectNext, taskMarker } from '../harness/lib/queue.mjs';

// Today's output for a consumer without "target". Must never change.
const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'no-target.json');
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'compat-project-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

function publishLog(projectDir, verdict) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-publish-'));
  execFileSync('git', ['-C', projectDir, 'bundle', 'create', join(dir, 'branch.bundle'), 'agent/issue-7'], { stdio: 'ignore' });
  const remote = join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [join(HERE, '..', 'harness', 'publish.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(HERE, 'stubs')}:${process.env.PATH}`,
      GH_LOG: log, VERDICT: join(dir, 'verdict.json'), REPO: 'o/r', GH_TOKEN: 'x',
      RUN_URL: 'https://run', BUNDLE: join(dir, 'branch.bundle'), PUSH_REMOTE: remote,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(log, 'utf8').replace(/--body-file \S+/g, '--body-file <file>');
}

async function snapshot() {
  const projectDir = project();
  const outDir = mkdtempSync(join(tmpdir(), 'compat-out-'));
  const AGENT_CMD = `sh "${join(HERE, 'fake-agents', 'honest.sh')}"`;
  const verdict = await runTask({ projectDir, issue: ISSUE, outDir, baseBranch: 'main', env: { ...process.env, AGENT_CMD } });
  const v = JSON.parse(JSON.stringify(verdict));
  delete v.baseSha;
  for (const c of Object.values(v.checks)) c.durationSec = 0;
  return {
    verdict: v,
    prompt: readFileSync(join(outDir, 'prompt.md'), 'utf8').replaceAll(outDir, '<out>'),
    prBody: renderPrBody(v),
    readyComment: renderComment(v, { runUrl: 'https://run', prUrl: 'https://pr' }),
    blockedComment: renderComment({ ...v, outcome: 'BLOCKED', kind: 'gate', reasons: ['x'] }, { runUrl: 'https://run' }),
    selection: selectNext({
      issues: [{ number: 9, title: 'T2', body: 'plan: docs/plan.md\ntask: 2', labels: [{ name: 'agent' }] }],
      prs: [{ headRefName: 'agent/issue-7', body: taskMarker({ plan: 'docs/plan.md', task: 1, issue: 7 }), isCrossRepository: false }],
      defaultBranch: 'main',
    }),
    publishLog: publishLog(projectDir, v),
  };
}

test('a consumer without "target" produces exactly the golden output', async () => {
  const actual = await snapshot();
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepEqual(actual, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});
```

- [ ] **Step 2: Generate the golden file from today's code**

Run: `UPDATE_GOLDEN=1 node --test test/compat.test.mjs`
Expected: PASS, and `test/golden/no-target.json` exists with `verdict.outcome` `"READY_FOR_QA"`, `verdict.branch` `"agent/issue-7"`, and a `publishLog` containing `gh pr create --repo o/r --base main --head agent/issue-7`.

- [ ] **Step 3: Run it in compare mode, twice**

Run: `node --test test/compat.test.mjs && node --test test/compat.test.mjs`
Expected: PASS both times (the snapshot is deterministic). If it differs between runs, find the volatile field, normalise it in `snapshot()`, regenerate, and repeat.

- [ ] **Step 4: Prove the test can fail**

Temporarily change `'agent/issue-${issue.number}'` to `'agent/issue-x${issue.number}'` in `harness/run-task.mjs`, run `node --test test/compat.test.mjs`, expect FAIL, then revert with `git checkout harness/run-task.mjs`.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add test/compat.test.mjs test/golden/no-target.json
git commit -m "test: golden output for consumers without a target"
```

---

## Task 2: Pure target helpers

**Files:**
- Create: `harness/lib/target.mjs`
- Test: `test/target.test.mjs`

**Interfaces:**
- Produces:
  - `BRANCH_RE: RegExp`
  - `RELATED_TOKEN: string` (`'<!-- agent-related -->'`)
  - `TEMPLATE_VARS: string[]` (`['issue','task','taskTitle','summary','changedFiles','checks','related']`)
  - `splitTaskType(title: string) → { type: string, title: string }`
  - `slugify(text: string) → string`
  - `fill(template: string, vars: Record<string,string>) → string` — throws `template uses unknown variable {x}`
  - `renderBranch(template: string, { issue: number, task: number, taskTitle: string }) → string` — throws `branch template uses unknown variable {x}` or `branch name "<b>" is not allowed`
  - `parseGitmodules(text: string) → Array<{ path: string, repo: string }>` — throws on a bad entry
  - `targetsMarker(prs: Array<{repo,number,branch,base,role}>) → string`
  - `parseTargetsMarker(text: string) → Array<{repo,number,branch,base,role}> | null`
  - `latestTargets(comments: Array<{ body: string }>) → Array<…> | null` — marker of the most recent `✅ **READY_FOR_QA**` comment
  - `targetPromptSection({ path, repo, branch }) → string`

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/target.test.mjs`
Expected: FAIL with `Cannot find module '.../harness/lib/target.mjs'`.

- [ ] **Step 3: Implement `harness/lib/target.mjs`**

```js
// Pure helpers for tasks whose code lives in a separate target repository.
export const BRANCH_RE = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
export const RELATED_TOKEN = '<!-- agent-related -->';
export const TEMPLATE_VARS = ['issue', 'task', 'taskTitle', 'summary', 'changedFiles', 'checks', 'related'];

const TYPES = ['feat', 'fix', 'chore', 'refactor', 'test', 'docs', 'perf'];
const TYPE_RE = new RegExp(`^(${TYPES.join('|')}):\\s*(.+)$`);

export function splitTaskType(title) {
  const text = String(title).trim();
  const m = TYPE_RE.exec(text);
  return m ? { type: m[1], title: m[2] } : { type: 'fix', title: text };
}

export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
}

export function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`template uses unknown variable {${name}}`);
    return vars[name];
  });
}

export function renderBranch(template, { issue, task, taskTitle }) {
  const { type, title } = splitTaskType(taskTitle);
  const vars = { slug: slugify(title), type, issue: String(issue), task: String(task) };
  const branch = String(template).replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`branch template uses unknown variable {${name}}`);
    return vars[name];
  });
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new Error(`branch name "${branch}" is not allowed`);
  }
  return branch;
}

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export function parseGitmodules(text) {
  const entries = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[submodule\s+"[^"]*"\]$/.test(line)) {
      current = {};
      entries.push(current);
      continue;
    }
    const m = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (m && current) current[m[1]] = m[2].trim();
  }
  return entries.map((e) => {
    if (!e.path || !e.url) throw new Error('.gitmodules entry without path or url');
    const u = GITHUB_URL.exec(e.url);
    if (!u) throw new Error(`unsupported submodule URL "${e.url}" (only https://github.com/<owner>/<name>)`);
    if (e.path.startsWith('/') || e.path.split('/').includes('..')) throw new Error(`submodule path "${e.path}" must be relative`);
    return { path: e.path, repo: u[1] };
  });
}

const MARKER_RE = /<!-- agent-targets (\{.*?\}) -->/s;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function targetsMarker(prs) {
  return `<!-- agent-targets ${JSON.stringify({ prs })} -->`;
}

// The marker reaches shell steps (as a checkout ref and PR base), so every field is checked.
export function parseTargetsMarker(text) {
  const m = MARKER_RE.exec(String(text ?? ''));
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(data?.prs)) return null;
  const valid = data.prs.every((p) =>
    typeof p?.repo === 'string' && REPO_RE.test(p.repo)
    && Number.isInteger(p.number)
    && typeof p.branch === 'string' && BRANCH_RE.test(p.branch)
    && typeof p.base === 'string' && BRANCH_RE.test(p.base)
    && (p.role === 'sub' || p.role === 'super'));
  return valid ? data.prs : null;
}

export function latestTargets(comments) {
  const ready = (comments ?? []).filter((c) => String(c?.body ?? '').startsWith('✅ **READY_FOR_QA**'));
  return ready.length ? parseTargetsMarker(ready.at(-1).body) : null;
}

export function targetPromptSection({ path, repo, branch }) {
  return [
    '',
    '## Target repository',
    '',
    `- The code to change is in \`${path}\`, a clone of \`${repo}\` with its submodules. Every repository there already has branch \`${branch}\` checked out; stay on it.`,
    '- Commit inside a submodule first, then commit in the superproject so its submodule pointer includes that commit.',
    '- Commit in this repository (the root) only what the task asks for here.',
    `- In CHANGED_FILES, list target files by their path from the root, for example \`${path}/src/x.ts\`.`,
    '- Do not push and do not change remotes.',
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/target.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Full suite and commit**

Run: `npm test` — Expected: PASS.

```bash
git add harness/lib/target.mjs test/target.test.mjs
git commit -m "feat: pure helpers for target repositories"
```

---

## Task 3: Config field `target`

**Files:**
- Modify: `harness/lib/config.mjs`
- Test: `test/config.test.mjs` (append only)

**Interfaces:**
- Consumes: `renderBranch`, `fill`, `TEMPLATE_VARS` from Task 2.
- Produces: `loadConfig(text).target: null | { repo: string, path: string, branch: string, pr: { title: string, body: string | null }, author: { name: string, email: string } | null }`.

- [ ] **Step 1: Append failing tests to `test/config.test.mjs`**

```js
test('target is null by default', () => {
  assert.equal(loadConfig(minimal).target, null);
});

test('accepts a target and fills its defaults', () => {
  const c = loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, target: { repo: 'o/super', path: 'target' } }));
  assert.deepEqual(c.target, {
    repo: 'o/super', path: 'target', branch: 'agent/issue-{issue}',
    pr: { title: 'Task {task}: {taskTitle}', body: null }, author: null,
  });
});

test('accepts a full target', () => {
  const target = {
    repo: 'o/super', path: 'work/super', branch: '{type}/{slug}',
    pr: { title: '{taskTitle}', body: '.github/agent-pr-body.md' },
    author: { name: 'Jane Doe', email: 'jane@example.com' },
  };
  assert.deepEqual(loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, target })).target, target);
});

test('rejects a bad target', () => {
  const load = (target) => loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, target }));
  assert.throws(() => load('o/super'), /"target" must be an object/);
  assert.throws(() => load({ path: 't' }), /"target\.repo" must be "owner\/name"/);
  assert.throws(() => load({ repo: 'o/super' }), /"target\.path" must be a relative path inside the project/);
  for (const path of ['/abs', '../up', 'a/../b', 't/', '.', '']) {
    assert.throws(() => load({ repo: 'o/s', path }), /"target\.path" must be a relative path inside the project/, path);
  }
  assert.throws(() => load({ repo: 'o/s', path: 't', branch: '{nope}' }), /"target\.branch": branch template uses unknown variable \{nope\}/);
  assert.throws(() => load({ repo: 'o/s', path: 't', branch: 'Upper/{slug}' }), /"target\.branch": branch name/);
  assert.throws(() => load({ repo: 'o/s', path: 't', pr: { title: '{bad}' } }), /"target\.pr\.title": template uses unknown variable \{bad\}/);
  assert.throws(() => load({ repo: 'o/s', path: 't', pr: { body: '../x.md' } }), /"target\.pr\.body" must be a relative path inside the project/);
  assert.throws(() => load({ repo: 'o/s', path: 't', author: { name: 'x' } }), /"target\.author" must have string "name" and "email"/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `c.target` is `undefined`, no errors thrown.

- [ ] **Step 3: Implement in `harness/lib/config.mjs`**

Add the import at the top:

```js
import { renderBranch, fill, TEMPLATE_VARS } from './target.mjs';
```

Add above `export function loadConfig`:

```js
const relativeInside = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

function targetConfig(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('"target" must be an object');
  const { repo, path, branch = 'agent/issue-{issue}', pr = {}, author = null } = value;
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('"target.repo" must be "owner/name"');
  if (!relativeInside(path)) throw new Error('"target.path" must be a relative path inside the project');
  if (typeof branch !== 'string') throw new Error('"target.branch" must be a string');
  try {
    renderBranch(branch, { issue: 1, task: 1, taskTitle: 'feat: check' });
  } catch (e) {
    throw new Error(`"target.branch": ${e.message}`);
  }
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) throw new Error('"target.pr" must be an object');
  const title = pr.title ?? 'Task {task}: {taskTitle}';
  if (typeof title !== 'string' || !title.trim()) throw new Error('"target.pr.title" must be a non-empty string');
  try {
    fill(title, Object.fromEntries(TEMPLATE_VARS.map((v) => [v, ''])));
  } catch (e) {
    throw new Error(`"target.pr.title": ${e.message}`);
  }
  const body = pr.body ?? null;
  if (body !== null && !relativeInside(body)) throw new Error('"target.pr.body" must be a relative path inside the project');
  if (author !== null && (typeof author?.name !== 'string' || typeof author?.email !== 'string')) {
    throw new Error('"target.author" must have string "name" and "email"');
  }
  return { repo, path, branch, pr: { title, body }, author: author && { name: author.name, email: author.email } };
}
```

In the object returned by `loadConfig`, add after `artifacts: artifactGlobs(raw.artifacts),`:

```js
    target: targetConfig(raw.target),
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/config.test.mjs` — Expected: PASS.

- [ ] **Step 5: Full suite and commit**

Run: `npm test` — Expected: PASS, including `test/compat.test.mjs`.

```bash
git add harness/lib/config.mjs test/config.test.mjs
git commit -m "feat: target field in agent.config.json"
```

---

## Task 4: Gate rule for submodule pointers

**Files:**
- Modify: `harness/lib/gate.mjs`
- Test: `test/gate.test.mjs` (append only)

**Interfaces:**
- Produces: `decide({ …, pointerErrors?: string[] })`. Non-empty `pointerErrors` → `BLOCKED (gate)` with those reasons, evaluated right after protected paths. Absent or empty → unchanged behaviour.

- [ ] **Step 1: Append failing tests**

```js
test('submodule pointer errors block after protected paths', () => {
  const errors = ['submodule target/sub changed but the superproject does not point at it'];
  const d = run({ pointerErrors: errors });
  assert.equal(d.outcome, 'BLOCKED');
  assert.equal(d.kind, 'gate');
  assert.deepEqual(d.reasons, errors);
  const p = run({ pointerErrors: errors, diff: [{ status: 'M', path: '.github/workflows/x.yml' }] });
  assert.match(p.reasons[0], /protected paths/);
});

test('empty pointer errors change nothing', () => {
  assert.equal(run({ pointerErrors: [] }).outcome, 'READY_FOR_QA');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/gate.test.mjs` — Expected: FAIL (first test gets `READY_FOR_QA`).

- [ ] **Step 3: Implement**

In `harness/lib/gate.mjs`, change the signature to:

```js
export function decide({ agent, reportText, commits, diff, checks, config, pointerErrors = [] }) {
```

and insert directly after the `protectedHits` block's closing `}`:

```js
  if (pointerErrors.length) return blocked('gate', pointerErrors, { report });
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/gate.test.mjs` — Expected: PASS.

- [ ] **Step 5: Full suite and commit**

Run: `npm test` — Expected: PASS.

```bash
git add harness/lib/gate.mjs test/gate.test.mjs
git commit -m "feat: block when a changed submodule is not pinned by the superproject"
```

---

## Task 5: Target PR text and issue comments

**Files:**
- Modify: `harness/lib/format.mjs`
- Test: `test/format.test.mjs` (append only)

**Interfaces:**
- Consumes: `fill`, `splitTaskType`, `RELATED_TOKEN`, `targetsMarker` (Task 2).
- Produces:
  - `renderTargetPr({ titleTemplate, bodyTemplate: string|null, issue, task, taskTitle, report, checks, changedFiles: string[] }) → { prTitle, prBody }` — `prBody` contains `RELATED_TOKEN` where `{related}` was.
  - `renderComment(v, { runUrl, prUrl, targetPrs })` — `targetPrs: Array<{repo, number, url, branch, base, role}>`; without it, output is unchanged.

- [ ] **Step 1: Append failing tests**

```js
import { renderTargetPr } from '../harness/lib/format.mjs';
import { parseTargetsMarker, RELATED_TOKEN } from '../harness/lib/target.mjs';

const prArgs = {
  titleTemplate: 'Task {task}: {taskTitle}', bodyTemplate: null, issue: 7, task: 3, taskTitle: 'feat: Add picker',
  report: { summary: 'Added picker.' }, checks: { test: { ok: true }, lint: { ok: true } }, changedFiles: ['src/a.ts'],
};

test('target PR default text has no harness marker or issue link', () => {
  const { prTitle, prBody } = renderTargetPr(prArgs);
  assert.equal(prTitle, 'Task 3: Add picker');
  assert.match(prBody, /## Summary\nAdded picker\./);
  assert.match(prBody, /## Changed files\n- `src\/a\.ts`/);
  assert.match(prBody, /## Checks\n- test: PASS\n- lint: PASS/);
  assert.ok(prBody.includes(RELATED_TOKEN));
  assert.doesNotMatch(prBody, /agent-task|Closes #/);
});

test('target PR uses the consumer templates', () => {
  const { prTitle, prBody } = renderTargetPr({ ...prArgs, titleTemplate: '{taskTitle}', bodyTemplate: 'Why: {summary}\n{related}' });
  assert.equal(prTitle, 'Add picker');
  assert.equal(prBody, `Why: Added picker.\n${RELATED_TOKEN}`);
  assert.throws(() => renderTargetPr({ ...prArgs, bodyTemplate: '{oops}' }), /unknown variable \{oops\}/);
});

const targetPrs = [
  { repo: 'o/sub', number: 45, url: 'https://github.com/o/sub/pull/45', branch: 'feat/x', base: 'main', role: 'sub' },
  { repo: 'o/super', number: 123, url: 'https://github.com/o/super/pull/123', branch: 'feat/x', base: 'main', role: 'super' },
];

test('ready comment with target PRs lists them and carries the marker', () => {
  const c = renderComment(readyVerdict, { runUrl: 'https://run', targetPrs });
  assert.match(c, /^✅ \*\*READY_FOR_QA\*\* — https:\/\/github\.com\/o\/super\/pull\/123/);
  assert.match(c, /- `o\/sub` #45 \(draft\): https:\/\/github\.com\/o\/sub\/pull\/45/);
  assert.deepEqual(parseTargetsMarker(c), targetPrs.map(({ url, ...rest }) => rest));
});

test('blocked comment with targets reports consumer pushes and unpushed targets', () => {
  const v = {
    ...readyVerdict, outcome: 'BLOCKED', kind: 'gate', reasons: ['x'], report: null, checks: {}, warnings: [],
    commits: 3, consumerCommits: 0, targets: [{ repo: 'o/super', commits: 3 }],
  };
  const c = renderComment(v, { runUrl: 'https://run' });
  assert.doesNotMatch(c, /pushed to `agent\/issue-7`/);
  assert.match(c, /Changes to the target repositories were not pushed; their bundles are in the run artifact\./);
});
```

(Place the two `import` lines with the file's existing imports at the top.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/format.test.mjs` — Expected: FAIL with `renderTargetPr` not exported.

- [ ] **Step 3: Implement in `harness/lib/format.mjs`**

Add to the imports:

```js
import { fill, splitTaskType, RELATED_TOKEN, targetsMarker } from './target.mjs';
```

Add before `export function renderComment`:

```js
const DEFAULT_TARGET_BODY = '## Summary\n{summary}\n\n## Changed files\n{changedFiles}\n\n## Checks\n{checks}\n\n{related}\n';

export function renderTargetPr({ titleTemplate, bodyTemplate, issue, task, taskTitle, report, checks, changedFiles }) {
  const vars = {
    issue: String(issue),
    task: String(task),
    taskTitle: splitTaskType(taskTitle).title,
    summary: report.summary,
    changedFiles: changedFiles.map((p) => `- \`${p}\``).join('\n') || '- (none)',
    checks: Object.entries(checks ?? {}).map(([name, c]) => `- ${name}: ${c.ok ? 'PASS' : 'FAIL'}`).join('\n'),
    related: RELATED_TOKEN,
  };
  return { prTitle: fill(titleTemplate, vars), prBody: fill(bodyTemplate ?? DEFAULT_TARGET_BODY, vars) };
}
```

Replace the READY branch at the top of `renderComment` and its signature with:

```js
export function renderComment(v, { runUrl, prUrl, targetPrs } = {}) {
  if (v.outcome === 'READY_FOR_QA') {
    const main = prUrl ?? targetPrs?.find((p) => p.role === 'super')?.url ?? 'PR opened';
    const head = `✅ **READY_FOR_QA** — ${main}\n\n${runLink(v, runUrl)}`;
    if (!targetPrs?.length) return head;
    const list = targetPrs.map((p) => `- \`${p.repo}\` #${p.number} (draft): ${p.url}`).join('\n');
    const marker = targetsMarker(targetPrs.map(({ repo, number, branch, base, role }) => ({ repo, number, branch, base, role })));
    return `${head}\n\n${list}\n\n${marker}`;
  }
```

Replace the line `if (v.commits > 0) lines.push('', \`The attempt was pushed to \\\`${v.branch}\\\` for inspection.\`);` with:

```js
  const pushed = v.targets ? v.consumerCommits : v.commits;
  if (pushed > 0) lines.push('', `The attempt was pushed to \`${v.branch}\` for inspection.`);
  if (v.targets?.some((t) => t.commits > 0)) lines.push('', 'Changes to the target repositories were not pushed; their bundles are in the run artifact.');
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/format.test.mjs` — Expected: PASS.

- [ ] **Step 5: Full suite and commit**

Run: `npm test` — Expected: PASS, including `test/compat.test.mjs`.

```bash
git add harness/lib/format.mjs test/format.test.mjs
git commit -m "feat: target PR text and target-aware issue comments"
```

---

## Task 6: Queue — stacking on a target parent and close-on-merge candidates

**Files:**
- Modify: `harness/lib/queue.mjs`
- Test: `test/queue.test.mjs` (append only)

**Interfaces:**
- Consumes: `latestTargets` (Task 2), `parseTaskRef` (existing).
- Produces:
  - `selectNext({ issues, prs, defaultBranch, ready = [] })` — `ready`: `Array<{ number, body, comments: [{ body }] }>` (open `agent:ready` issues). When a parent with a valid marker exists, the result gains `targets: { superBranch: string|null, bases: Record<repo, branch> }`; otherwise the result is unchanged.
  - `targetsToCheck(ready) → Array<{ issue: number, repo: string, number: number }>` — the superproject PR of each issue's latest READY marker.

- [ ] **Step 1: Append failing tests**

```js
import { targetsToCheck } from '../harness/lib/queue.mjs';
import { targetsMarker } from '../harness/lib/target.mjs';

const readyIssue = (number, task, prsList, plan = 'docs/p.md') => ({
  number, body: `plan: ${plan}\ntask: ${task}`, comments: [{ body: `✅ **READY_FOR_QA** — u\n\n${targetsMarker(prsList)}` }],
});
const tp = (branch, extra = []) => [
  ...extra,
  { repo: 'o/super', number: 10, branch, base: 'main', role: 'super' },
];

test('no ready parents leaves the selection without targets', () => {
  const s = selectNext({ issues: [issue(3, 2, ['agent'])], prs: [], defaultBranch: 'main', ready: [] });
  assert.equal('targets' in s, false);
});

test('stacks target bases on the highest earlier ready task of the same plan', () => {
  const ready = [
    readyIssue(1, 1, tp('fix/one')),
    readyIssue(2, 2, tp('fix/two', [{ repo: 'o/sub', number: 4, branch: 'fix/two', base: 'main', role: 'sub' }])),
    readyIssue(8, 2, tp('fix/other'), 'docs/other.md'),
    readyIssue(5, 4, tp('fix/later')),
  ];
  const s = selectNext({ issues: [issue(3, 3, ['agent'])], prs: [], defaultBranch: 'main', ready });
  assert.deepEqual(s.targets, { superBranch: 'fix/two', bases: { 'o/sub': 'fix/two', 'o/super': 'fix/two' } });
});

test('ignores a parent whose marker is unsafe', () => {
  const bad = { number: 2, body: 'plan: docs/p.md\ntask: 2', comments: [{ body: '✅ **READY_FOR_QA** — u\n\n<!-- agent-targets {"prs":[{"repo":"o/super","number":1,"branch":"x; rm -rf /","base":"main","role":"super"}]} -->' }] };
  const s = selectNext({ issues: [issue(3, 3, ['agent'])], prs: [], defaultBranch: 'main', ready: [bad] });
  assert.equal('targets' in s, false);
});

test('targetsToCheck returns each issue\'s superproject PR', () => {
  const ready = [readyIssue(1, 1, tp('fix/one')), { number: 2, body: 'plan: docs/p.md\ntask: 2', comments: [{ body: 'hi' }] }];
  assert.deepEqual(targetsToCheck(ready), [{ issue: 1, repo: 'o/super', number: 10 }]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/queue.test.mjs` — Expected: FAIL (`targetsToCheck` not exported).

- [ ] **Step 3: Implement in `harness/lib/queue.mjs`**

Add to the imports:

```js
import { latestTargets } from './target.mjs';
```

Add after `parseTaskMarker`:

```js
function targetParent({ ready, plan, task }) {
  const parent = (ready ?? [])
    .map((r) => ({ ref: parseTaskRef(r.body), prs: latestTargets(r.comments) }))
    .filter((p) => !p.ref.error && p.prs && p.ref.plan === plan && p.ref.task < task)
    .sort((a, b) => b.ref.task - a.ref.task)[0];
  if (!parent) return null;
  return {
    superBranch: parent.prs.find((p) => p.role === 'super')?.branch ?? null,
    bases: Object.fromEntries(parent.prs.map((p) => [p.repo, p.branch])),
  };
}

export function targetsToCheck(ready) {
  return (ready ?? []).flatMap((r) => {
    const sup = latestTargets(r.comments)?.find((p) => p.role === 'super');
    return sup ? [{ issue: r.number, repo: sup.repo, number: sup.number }] : [];
  });
}
```

Change the signature to `export function selectNext({ issues, prs, defaultBranch, ready = [] }) {` and replace the final `return { issue, plan, task, base: parent ? parent.head : defaultBranch, skip: null };` with:

```js
  const targets = targetParent({ ready, plan, task });
  return { issue, plan, task, base: parent ? parent.head : defaultBranch, skip: null, ...(targets ? { targets } : {}) };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/queue.test.mjs` — Expected: PASS.

- [ ] **Step 5: Full suite and commit**

Run: `npm test` — Expected: PASS.

```bash
git add harness/lib/queue.mjs test/queue.test.mjs
git commit -m "feat: stack target tasks on a ready parent and list PRs to check for merge"
```

---

## Task 7: Run a task against a target clone — preparation, branches, prompt, clean

**Files:**
- Create: `harness/lib/target-run.mjs`
- Modify: `harness/run-task.mjs`
- Create: `test/helpers/target-fixture.mjs`
- Create: `test/fake-agents/target-honest.sh`
- Create: `test/fake-agents/env-dump.sh`
- Test: `test/target-pipeline.test.mjs`

**Interfaces:**
- Consumes: Task 2 helpers; `config.target` (Task 3).
- Produces (`harness/lib/target-run.mjs`):
  - `prepareTarget({ projectDir, outDir, target, issue, task, taskTitle, parentBases }) → { error } | { branch, repos, prTemplate }` where `repos: Array<{ repo, path, role: 'sub'|'super', subPath?, dir, base: string|null }>`, submodules deepest first, superproject last.
  - `startTargetBranches(t, author)` — sets `r.baseSha` on each repo.
  - `resetTargets(t)`
  - `runTask({ …, selection })` — `selection.targets.bases` feeds `parentBases`.
- Produces (`test/helpers/target-fixture.mjs`): `makeTargetProject({ mutate, gitignore = true, targetConfig = {} }) → { projectDir, remotes: { sub, super } }`, `runTarget({ agent, cmd, mutate, gitignore, targetConfig, selection, env, beforeRun }) → { verdict, projectDir, outDir }`.

- [ ] **Step 1: Write the fixture helper `test/helpers/target-fixture.mjs`**

```js
import { cpSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTask } from '../../harness/run-task.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
export const AGENTS = join(HERE, '..', 'fake-agents');
export const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };

const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A bare superproject whose .gitmodules names https://github.com/o/sub.git, plus the
// environment that makes git resolve that URL to a local bare repository.
function makeRemotes(root) {
  const sub = join(root, 'sub.git');
  const sup = join(root, 'super.git');
  const subWork = join(root, 'sub-work');
  const supWork = join(root, 'super-work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', sub]);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', sup]);
  for (const bare of [sub, sup]) git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  execFileSync('git', ['init', '-q', '-b', 'main', subWork]);
  writeFileSync(join(subWork, 'lib.txt'), 'a\n');
  git(subWork, 'add', '-A');
  git(subWork, 'commit', '-qm', 'sub base');
  git(subWork, 'push', '-q', sub, 'main');
  execFileSync('git', ['init', '-q', '-b', 'main', supWork]);
  writeFileSync(join(supWork, 'app.txt'), 'app\n');
  git(supWork, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'packages/core');
  git(supWork, 'config', '-f', '.gitmodules', 'submodule.packages/core.url', 'https://github.com/o/sub.git');
  git(supWork, 'add', '-A');
  git(supWork, 'commit', '-qm', 'super base');
  git(supWork, 'push', '-q', sup, 'main');
  const gitEnv = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.${sub}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/o/sub.git',
    GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always',
  };
  return { sub, super: sup, gitEnv };
}

export function makeTargetProject({ mutate, gitignore = true, targetConfig = {}, ref = 'main' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-target-'));
  const remotes = makeRemotes(root);
  const projectDir = join(root, 'project');
  cpSync(join(HERE, '..', 'fixtures', 'project'), projectDir, { recursive: true });
  const configPath = join(projectDir, 'agent.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.target = { repo: 'o/super', path: 'target', branch: '{type}/{slug}', ...targetConfig };
  config.testGlobs = ['tests/**', 'target/**/tests/**'];
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  if (gitignore) writeFileSync(join(projectDir, '.gitignore'), 'build/\ntarget/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', projectDir]);
  if (mutate) mutate(projectDir);
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-qm', 'fixture');
  // What the workflow's checkout step does: clone with submodules into the target path.
  execFileSync('git', ['clone', '-q', '--recurse-submodules', '-b', ref, remotes.super, join(projectDir, 'target')], {
    env: { ...process.env, ...remotes.gitEnv }, stdio: 'ignore',
  });
  return { projectDir, remotes };
}

export async function runTarget({ agent, cmd, mutate, gitignore, targetConfig, selection = null, env = {}, beforeRun } = {}) {
  const { projectDir, remotes } = makeTargetProject({ mutate, gitignore, targetConfig });
  const outDir = mkdtempSync(join(tmpdir(), 'harness-target-out-'));
  if (beforeRun) beforeRun({ projectDir, outDir });
  const AGENT_CMD = cmd ?? `sh "${join(AGENTS, agent)}"`;
  const verdict = await runTask({
    projectDir, issue: ISSUE, outDir, baseBranch: 'main', selection,
    env: { ...process.env, ...env, AGENT_CMD },
  });
  return { verdict, projectDir, outDir, remotes };
}
```

- [ ] **Step 2: Write the fake agents**

`test/fake-agents/target-honest.sh`:

```sh
set -e
. "$(dirname "$0")/lib.sh"
cd target/packages/core
echo b > lib.txt
git add -A
git commit -qm "Change lib"
cd ../..
git add packages/core
git commit -qm "Point at the new lib"
cd ..
ready_report target/packages/core/lib.txt target/packages/core
```

`test/fake-agents/env-dump.sh`:

```sh
set -e
. "$(dirname "$0")/lib.sh"
env > "$(dirname "$REPORT_PATH")/agent-env.txt"
ready_report
```

- [ ] **Step 3: Write the failing tests `test/target-pipeline.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runTarget } from './helpers/target-fixture.mjs';

const head = (dir) => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

test('target branches are created in every repository and the prompt names the target', async () => {
  const { verdict, projectDir, outDir } = await runTarget({ agent: 'target-honest.sh' });
  assert.notEqual(verdict.kind, 'harness', JSON.stringify(verdict.reasons));
  assert.equal(head(projectDir), 'agent/issue-7');
  assert.equal(head(join(projectDir, 'target')), 'fix/add-greeting');
  assert.equal(head(join(projectDir, 'target', 'server', 'ee')), 'fix/add-greeting');
  const prompt = readFileSync(join(outDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /## Target repository/);
  assert.match(prompt, /`target`, a clone of `o\/super`/);
});

test('target clone survives the verification clean', async () => {
  const { projectDir } = await runTarget({ agent: 'target-honest.sh' });
  assert.ok(existsSync(join(projectDir, 'target', 'app.txt')));
  assert.equal(readFileSync(join(projectDir, 'target', 'server', 'ee', 'lib.txt'), 'utf8'), 'b\n');
});

test('a target path that is not git-ignored blocks before the agent runs', async () => {
  const { verdict } = await runTarget({ agent: 'target-honest.sh', gitignore: false });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'harness');
  assert.deepEqual(verdict.reasons, ['target path "target" is not git-ignored']);
});

test('a checkout failure recorded by the workflow blocks', async () => {
  const { verdict } = await runTarget({
    agent: 'target-honest.sh',
    beforeRun: ({ outDir }) => writeFileSync(join(outDir, 'target-checkout.txt'), 'target checkout failed\n'),
  });
  assert.deepEqual(verdict.reasons, ['target checkout failed']);
  assert.equal(verdict.kind, 'harness');
});

test('a missing PR body template blocks', async () => {
  const { verdict } = await runTarget({ agent: 'target-honest.sh', targetConfig: { pr: { body: '.github/agent-pr-body.md' } } });
  assert.deepEqual(verdict.reasons, ['PR body template not found: .github/agent-pr-body.md']);
});

test('target tokens never reach the agent', async () => {
  const { outDir } = await runTarget({ agent: 'env-dump.sh', env: { TARGET_READ_TOKEN: 'secret-read', TARGET_PUSH_TOKEN: 'secret-push' } });
  const env = readFileSync(join(outDir, 'agent-env.txt'), 'utf8');
  assert.doesNotMatch(env, /secret-read|secret-push|TARGET_/);
});

test('the commit author comes from target.author', async () => {
  const { projectDir } = await runTarget({ agent: 'target-honest.sh', targetConfig: { author: { name: 'Jane Doe', email: 'jane@example.com' } } });
  const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: join(projectDir, 'target'), encoding: 'utf8' }).trim();
  assert.equal(author, 'Jane Doe <jane@example.com>');
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `node --test test/target-pipeline.test.mjs`
Expected: FAIL — `head(target)` is `main`, no `## Target repository` in the prompt, the not-ignored case reaches `READY_FOR_QA` or a gate block.

- [ ] **Step 5: Create `harness/lib/target-run.mjs`**

```js
// Git operations on the target clone (superproject + submodules) inside the consumer checkout.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseGitmodules, renderBranch, fill, TEMPLATE_VARS } from './target.mjs';

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function prepareTarget({ projectDir, outDir, target, issue, task, taskTitle, parentBases }) {
  const reasonFile = join(outDir, 'target-checkout.txt');
  if (existsSync(reasonFile)) return { error: readFileSync(reasonFile, 'utf8').trim() || 'target checkout failed' };
  if (spawnSync('git', ['check-ignore', '-q', `${target.path}/`], { cwd: projectDir }).status !== 0) {
    return { error: `target path "${target.path}" is not git-ignored` };
  }
  const superDir = join(projectDir, target.path);
  if (!existsSync(join(superDir, '.git'))) return { error: 'target checkout failed' };

  let branch;
  let subs;
  try {
    branch = renderBranch(target.branch, { issue: issue.number, task, taskTitle });
    const modules = join(superDir, '.gitmodules');
    subs = existsSync(modules) ? parseGitmodules(readFileSync(modules, 'utf8')) : [];
  } catch (e) {
    return { error: e.message };
  }

  let prTemplate = null;
  if (target.pr.body) {
    const p = join(projectDir, target.pr.body);
    if (!existsSync(p)) return { error: `PR body template not found: ${target.pr.body}` };
    prTemplate = readFileSync(p, 'utf8');
    try {
      fill(prTemplate, Object.fromEntries(TEMPLATE_VARS.map((v) => [v, ''])));
    } catch (e) {
      return { error: `PR body template ${target.pr.body}: ${e.message}` };
    }
  }

  const depth = (p) => p.split('/').length;
  const repos = [
    ...subs
      .filter((s) => existsSync(join(superDir, s.path, '.git')))
      .sort((a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path))
      .map((s) => ({ repo: s.repo, path: `${target.path}/${s.path}`, role: 'sub', subPath: s.path })),
    { repo: target.repo, path: target.path, role: 'super' },
  ].map((r) => ({ ...r, dir: join(projectDir, r.path), base: parentBases?.[r.repo] ?? null }));
  return { branch, repos, prTemplate };
}

export function startTargetBranches(t, author) {
  for (const r of t.repos) {
    git(r.dir, 'checkout', '-q', '-B', t.branch);
    git(r.dir, 'config', 'user.name', author?.name ?? 'agent-harness');
    git(r.dir, 'config', 'user.email', author?.email ?? 'agent-harness@users.noreply.github.com');
    r.baseSha = git(r.dir, 'rev-parse', 'HEAD');
  }
}

export function resetTargets(t) {
  for (const r of t.repos) {
    git(r.dir, 'checkout', '-q', '-f', t.branch);
    git(r.dir, 'reset', '-q', '--hard', r.baseSha);
    git(r.dir, 'clean', '-fdq');
  }
}
```

- [ ] **Step 6: Wire it into `harness/run-task.mjs`**

Add to the imports:

```js
import { prepareTarget, startTargetBranches, resetTargets } from './lib/target-run.mjs';
import { targetPromptSection } from './lib/target.mjs';
```

Change `runTask`'s signature to accept `selection` and pass it on:

```js
export async function runTask({ projectDir, issue, outDir, baseBranch, configPath, selection = null, env = process.env }) {
```

and in its `try` block:

```js
    return await execute({ projectDir, issue, outDir, logsDir, reportPath, configPath, selection, env, meta, finish, state });
```

Change `execute`'s parameter list to `async function execute({ projectDir, issue, outDir, logsDir, reportPath, configPath: configOverride, selection, env, meta, finish, state }) {`.

Directly after the line `meta.model = issue.labels.includes('agent:opus') ? 'opus' : config.model;` insert:

```js
  // Validate the target before any Claude usage or slow work.
  let target = null;
  if (config.target) {
    target = prepareTarget({
      projectDir, outDir, target: config.target, issue, task: ref.task, taskTitle: meta.taskTitle,
      parentBases: selection?.targets?.bases ?? null,
    });
    if (target.error) return finish(blocked('harness', target.error));
  }
```

Directly after `git(projectDir, 'config', 'user.email', 'agent-harness@users.noreply.github.com');` insert:

```js
  if (target) startTargetBranches(target, config.target.author);
```

Replace:

```js
  const promptFile = join(outDir, 'prompt.md');
  writeFileSync(promptFile, promptText);
```

with:

```js
  const fullPrompt = target
    ? promptText + targetPromptSection({ path: config.target.path, repo: config.target.repo, branch: target.branch })
    : promptText;
  const promptFile = join(outDir, 'prompt.md');
  writeFileSync(promptFile, fullPrompt);
```

and in the `agentCommand({ … })` call change `promptText,` to `promptText: fullPrompt,`.

In the usage-limit restart, after `git(projectDir, 'clean', '-fdq');` insert:

```js
    if (target) resetTargets(target);
```

Replace the verification clean line `git(projectDir, 'clean', '-ffdXq');` with:

```js
    // The target clone is git-ignored in the consumer, so it is excluded here and cleaned on its own.
    git(projectDir, 'clean', '-ffdXq', ...(target ? ['--', '.', `:(exclude)${config.target.path}`] : []));
    if (target) for (const r of target.repos) git(r.dir, 'clean', '-ffdXq');
```

In the CLI block at the end of the file, add `selection: { type: 'string' }` to the `parseArgs` options and pass `selection: values.selection ? JSON.parse(readFileSync(values.selection, 'utf8')) : null,` to `runTask`.

- [ ] **Step 7: Run to verify they pass**

Run: `node --test test/target-pipeline.test.mjs` — Expected: PASS (7 tests).
If `target clone survives the verification clean` fails, the `:(exclude)` pathspec did not protect the ignored directory: print `git clean -ndX -- . ':(exclude)target'` inside a fixture project to see what git would delete before changing anything.

- [ ] **Step 8: Full suite and commit**

Run: `npm test` — Expected: PASS, including `test/compat.test.mjs`.

```bash
git add harness/lib/target-run.mjs harness/run-task.mjs test/helpers/target-fixture.mjs test/fake-agents/target-honest.sh test/fake-agents/env-dump.sh test/target-pipeline.test.mjs
git commit -m "feat: prepare target clones, branch them and tell the agent"
```

---

## Task 8: Verify target changes — combined diff, gate rules, bundles, verdict

**Files:**
- Modify: `harness/lib/target-run.mjs`
- Modify: `harness/run-task.mjs`
- Create: `test/fake-agents/target-no-pointer.sh`, `test/fake-agents/target-edit-ci.sh`, `test/fake-agents/target-switch-branch.sh`
- Test: `test/target-pipeline.test.mjs` (append)

**Interfaces:**
- Consumes: Task 7 `prepareTarget` result; `decide({ pointerErrors })` (Task 4); `renderTargetPr` (Task 5).
- Produces (`target-run.mjs`): `targetsOffBranch(t) → { path, head } | null`, `stashTargets(t) → boolean`, `measureTargets(t, parseDiff)` (sets `r.commits`, `r.diff`, `r.prefixedDiff`), `pointerErrors(t) → string[]`, `bundleTargets(t, outDir) → Array<{ repo, path, role, branch, base, baseSha, commits, bundle: string|null }>`.
- Produces (verdict, only with a target): `targets: Array<{ repo, path, role, branch, base, baseSha, commits, bundle, prTitle, prBody }>` (`prTitle`/`prBody` null unless READY and commits > 0), `consumerCommits: number`; `commits` = consumer + all targets; `diff` includes prefixed target paths.

- [ ] **Step 1: Write the fake agents**

`test/fake-agents/target-no-pointer.sh`:

```sh
set -e
. "$(dirname "$0")/lib.sh"
cd target/packages/core
echo b > lib.txt
git add -A
git commit -qm "Change lib"
cd ../../..
ready_report target/packages/core/lib.txt
```

`test/fake-agents/target-edit-ci.sh`:

```sh
set -e
. "$(dirname "$0")/lib.sh"
cd target
mkdir -p .github/workflows
echo "on: push" > .github/workflows/x.yml
git add -A
git commit -qm "CI"
cd ..
ready_report target/.github/workflows/x.yml
```

`test/fake-agents/target-switch-branch.sh`:

```sh
set -e
. "$(dirname "$0")/lib.sh"
git -C target checkout -q -b elsewhere
ready_report
```

- [ ] **Step 2: Append failing tests to `test/target-pipeline.test.mjs`**

```js
test('READY with target commits: combined counts, thin bundles and PR text in the verdict', async () => {
  const { verdict, outDir, remotes } = await runTarget({ agent: 'target-honest.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.equal(verdict.consumerCommits, 0);
  assert.equal(verdict.commits, 2);
  assert.deepEqual(verdict.targets.map(({ repo, path, role, branch, base, commits, bundle }) => ({ repo, path, role, branch, base, commits, bundle })), [
    { repo: 'o/sub', path: 'target/packages/core', role: 'sub', branch: 'fix/add-greeting', base: null, commits: 1, bundle: 'bundles/o__sub.bundle' },
    { repo: 'o/super', path: 'target', role: 'super', branch: 'fix/add-greeting', base: null, commits: 1, bundle: 'bundles/o__super.bundle' },
  ]);
  assert.ok(verdict.diff.some((d) => d.path === 'target/packages/core/lib.txt'));
  const sup = verdict.targets[1];
  assert.equal(sup.prTitle, 'Task 1: Add greeting');
  assert.match(sup.prBody, /## Summary\nDid the task\./);
  // Thin bundle: it needs the base commit, which the remote has.
  execFileSync('git', ['clone', '-q', '--bare', remotes.super, join(outDir, 'verify.git')]);
  execFileSync('git', ['bundle', 'verify', join(outDir, sup.bundle)], { cwd: join(outDir, 'verify.git'), stdio: 'ignore' });
});

test('a submodule change the superproject does not point at blocks', async () => {
  const { verdict } = await runTarget({ agent: 'target-no-pointer.sh' });
  assert.equal(verdict.kind, 'gate');
  assert.deepEqual(verdict.reasons, ['submodule target/packages/core changed but the superproject does not point at it']);
});

test('editing CI inside the target blocks', async () => {
  const { verdict } = await runTarget({ agent: 'target-edit-ci.sh' });
  assert.equal(verdict.kind, 'gate');
  assert.match(verdict.reasons[0], /protected paths: target\/\.github\/workflows\/x\.yml/);
});

test('switching branch inside the target blocks', async () => {
  const { verdict } = await runTarget({ agent: 'target-switch-branch.sh' });
  assert.deepEqual(verdict.reasons, ['agent switched target to branch "elsewhere"; work must stay on fix/add-greeting']);
});

test('consumer-only commits leave targets with zero commits and no PR text', async () => {
  const { verdict } = await runTarget({ agent: 'honest.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.equal(verdict.consumerCommits, 1);
  assert.ok(verdict.targets.every((t) => t.commits === 0 && t.bundle === null && t.prBody === null));
});

test('a parent base from the selection is recorded per repository', async () => {
  const { verdict } = await runTarget({ agent: 'target-honest.sh', selection: { targets: { superBranch: 'main', bases: { 'o/super': 'fix/prev' } } } });
  assert.equal(verdict.targets.find((t) => t.role === 'super').base, 'fix/prev');
  assert.equal(verdict.targets.find((t) => t.role === 'sub').base, null);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/target-pipeline.test.mjs`
Expected: FAIL — `verdict.targets` undefined; no pointer block; CI edit in target passes.

- [ ] **Step 4: Append to `harness/lib/target-run.mjs`**

Add `mkdirSync, rmSync` to its `node:fs` import, then:

```js
export function targetsOffBranch(t) {
  for (const r of t.repos) {
    const head = git(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (head !== t.branch) return { path: r.path, head };
  }
  return null;
}

// Submodule pointer changes are left alone here; pointerErrors judges them.
export function stashTargets(t) {
  let stashed = false;
  for (const r of t.repos) {
    if (git(r.dir, 'status', '--porcelain', '--ignore-submodules=all')) {
      git(r.dir, 'stash', 'push', '--include-untracked', '-q', '-m', 'agent-harness: uncommitted changes');
      stashed = true;
    }
  }
  return stashed;
}

export function measureTargets(t, parseDiff) {
  for (const r of t.repos) {
    r.commits = Number(git(r.dir, 'rev-list', '--count', `${r.baseSha}..HEAD`));
    r.diff = parseDiff(git(r.dir, 'diff', '--name-status', '-M', r.baseSha, 'HEAD'));
    r.prefixedDiff = r.diff.map((d) => ({
      ...d,
      path: `${r.path}/${d.path}`,
      ...(d.oldPath ? { oldPath: `${r.path}/${d.oldPath}` } : {}),
    }));
  }
}

export function pointerErrors(t) {
  const sup = t.repos.find((r) => r.role === 'super');
  return t.repos
    .filter((r) => r.role === 'sub' && r.commits > 0)
    .filter((r) => git(sup.dir, 'rev-parse', `HEAD:${r.subPath}`) !== git(r.dir, 'rev-parse', 'HEAD'))
    .map((r) => `submodule ${r.path} changed but the superproject does not point at it`);
}

// Thin bundles (<base>..<branch>): the artifact carries the task's commits, not the history.
export function bundleTargets(t, outDir) {
  const dir = join(outDir, 'bundles');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return t.repos.map((r) => {
    let bundle = null;
    if (r.commits > 0) {
      bundle = `bundles/${r.repo.replace('/', '__')}.bundle`;
      git(r.dir, 'bundle', 'create', join(outDir, bundle), `${r.baseSha}..refs/heads/${t.branch}`);
    }
    return { repo: r.repo, path: r.path, role: r.role, branch: t.branch, base: r.base, baseSha: r.baseSha, commits: r.commits, bundle };
  });
}
```

- [ ] **Step 5: Wire it into `harness/run-task.mjs`**

Extend the `target-run.mjs` import to:

```js
import {
  prepareTarget, startTargetBranches, resetTargets, targetsOffBranch, stashTargets,
  measureTargets, pointerErrors, bundleTargets,
} from './lib/target-run.mjs';
import { renderTargetPr } from './lib/format.mjs';
```

After the consumer branch check (`if (head !== meta.branch) return finish(…);`) insert:

```js
  if (target) {
    const off = targetsOffBranch(target);
    if (off) return finish(blocked('gate', `agent switched ${off.path} to branch "${off.head}"; work must stay on ${target.branch}`));
  }
```

After the consumer `if (dirtyAfter) { … }` block insert:

```js
  if (target && stashTargets(target)) {
    warnings.push('agent left uncommitted changes in the target repositories; they were stashed and are not part of this result');
  }
```

Replace:

```js
  const commits = Number(git(projectDir, 'rev-list', '--count', `${baseSha}..HEAD`));
  const diff = parseDiff(git(projectDir, 'diff', '--name-status', '-M', baseSha, 'HEAD'));
```

with:

```js
  const consumerCommits = Number(git(projectDir, 'rev-list', '--count', `${baseSha}..HEAD`));
  const consumerDiff = parseDiff(git(projectDir, 'diff', '--name-status', '-M', baseSha, 'HEAD'));
  if (target) measureTargets(target, parseDiff);
  const commits = consumerCommits + (target ? target.repos.reduce((n, r) => n + r.commits, 0) : 0);
  const diff = target ? [...consumerDiff, ...target.repos.flatMap((r) => r.prefixedDiff)] : consumerDiff;
```

Replace the `decide` call with:

```js
  const gateConfig = target
    ? { ...config, protectedPaths: [...config.protectedPaths, ...target.repos.map((r) => `${r.path}/.github/**`)] }
    : config;
  const decision = decide({ agent, reportText, commits, diff, checks, config: gateConfig, pointerErrors: target ? pointerErrors(target) : [] });
```

Directly before `return finish({ ...decision,` insert:

```js
  let targetFields = {};
  if (target) {
    const ready = decision.outcome === 'READY_FOR_QA';
    const targets = bundleTargets(target, outDir).map((entry) => {
      const repo = target.repos.find((r) => r.repo === entry.repo);
      const pr = ready && entry.commits > 0
        ? renderTargetPr({
          titleTemplate: config.target.pr.title, bodyTemplate: target.prTemplate, issue: issue.number, task: ref.task,
          taskTitle: meta.taskTitle, report: decision.report, checks, changedFiles: repo.diff.map((d) => d.path),
        })
        : { prTitle: null, prBody: null };
      return { ...entry, ...pr };
    });
    targetFields = { targets, consumerCommits };
  }
```

and add `...targetFields,` as the last property inside that `finish({ … })` object.

- [ ] **Step 6: Run to verify they pass**

Run: `node --test test/target-pipeline.test.mjs` — Expected: PASS (13 tests).

- [ ] **Step 7: Full suite and commit**

Run: `npm test` — Expected: PASS, including `test/compat.test.mjs` (proves the verdict has no new keys without a target).

```bash
git add harness/lib/target-run.mjs harness/run-task.mjs test/fake-agents/target-no-pointer.sh test/fake-agents/target-edit-ci.sh test/fake-agents/target-switch-branch.sh test/target-pipeline.test.mjs
git commit -m "feat: verify target changes and bundle them per repository"
```

---

## Task 9: CLI commands for the workflow

**Files:**
- Modify: `harness/cli.mjs`
- Test: `test/cli.test.mjs` (append only)

**Interfaces:**
- Consumes: `selectNext({ ready })`, `targetsToCheck` (Task 6), `loadConfig` (Task 3), `renderComment({ targetPrs })` (Task 5).
- Produces:
  - `cli.mjs select … [--ready <f>]`
  - `cli.mjs target-info --config <f> --selection <f> --out <dir>` — prints `repo=…\npath=…\nref=…\n` for `$GITHUB_OUTPUT`; prints nothing without a target; with a target but `HAS_TARGET_READ_TOKEN`/`HAS_TARGET_PUSH_TOKEN` not both `true`, writes `<out>/target-checkout.txt` with the missing-secret reason and prints nothing.
  - `cli.mjs targets-to-check --ready <f>` — prints a JSON array.
  - `cli.mjs render-comment … [--target-prs <f>]`

- [ ] **Step 1: Append failing tests**

```js
import { readFileSync, existsSync, mkdtempSync as mk } from 'node:fs';
import { targetsMarker } from '../harness/lib/target.mjs';

const cliEnv = (env, ...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const targetConfig = file('target.config.json', { install: 'x', checks: { t: 'y' }, target: { repo: 'o/super', path: 'target' } });
const plainConfig = file('plain.config.json', { install: 'x', checks: { t: 'y' } });
const both = { HAS_TARGET_READ_TOKEN: 'true', HAS_TARGET_PUSH_TOKEN: 'true' };

test('target-info prints repo, path and the stacked ref', () => {
  const sel = file('tsel.json', { targets: { superBranch: 'fix/prev', bases: {} } });
  const out = mk(join(tmpdir(), 'cli-out-'));
  assert.equal(cliEnv(both, 'target-info', '--config', targetConfig, '--selection', sel, '--out', out), 'repo=o/super\npath=target\nref=fix/prev\n');
  const plain = file('psel.json', {});
  assert.equal(cliEnv(both, 'target-info', '--config', targetConfig, '--selection', plain, '--out', out), 'repo=o/super\npath=target\nref=\n');
});

test('target-info prints nothing without a target', () => {
  const out = mk(join(tmpdir(), 'cli-out-'));
  assert.equal(cliEnv(both, 'target-info', '--config', plainConfig, '--selection', file('s0.json', {}), '--out', out), '');
  assert.equal(existsSync(join(out, 'target-checkout.txt')), false);
});

test('target-info records missing secrets instead of printing a repo', () => {
  const out = mk(join(tmpdir(), 'cli-out-'));
  assert.equal(cliEnv({ HAS_TARGET_READ_TOKEN: 'true', HAS_TARGET_PUSH_TOKEN: 'false' }, 'target-info', '--config', targetConfig, '--selection', file('s1.json', {}), '--out', out), '');
  assert.equal(readFileSync(join(out, 'target-checkout.txt'), 'utf8'), 'target configured but TARGET_READ_TOKEN or TARGET_PUSH_TOKEN secret missing\n');
});

const markerPrs = [{ repo: 'o/super', number: 10, branch: 'fix/one', base: 'main', role: 'super' }];
const readyFile = file('ready.json', [{ number: 1, body: 'plan: docs/p.md\ntask: 1', comments: [{ body: `✅ **READY_FOR_QA** — u\n\n${targetsMarker(markerPrs)}` }] }]);

test('select uses --ready for target stacking', () => {
  const s = JSON.parse(cli('select', '--issues', issues, '--prs', prs, '--default-branch', 'main', '--ready', readyFile));
  assert.deepEqual(s.targets, { superBranch: 'fix/one', bases: { 'o/super': 'fix/one' } });
});

test('targets-to-check lists superproject PRs', () => {
  assert.deepEqual(JSON.parse(cli('targets-to-check', '--ready', readyFile)), [{ issue: 1, repo: 'o/super', number: 10 }]);
});

test('render-comment accepts --target-prs', () => {
  const v = file('rv.json', { outcome: 'READY_FOR_QA', warnings: [], checks: {} });
  const tprs = file('tprs.json', [{ ...markerPrs[0], url: 'https://github.com/o/super/pull/10' }]);
  const c = cli('render-comment', '--verdict', v, '--run-url', 'https://run', '--target-prs', tprs);
  assert.match(c, /READY_FOR_QA\*\* — https:\/\/github\.com\/o\/super\/pull\/10/);
  assert.match(c, /<!-- agent-targets /);
});
```

(Merge the new `node:fs` names into the file's existing `node:fs` import if your linter prefers; `tmpdir` and `join` are already imported.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/cli.test.mjs` — Expected: FAIL (`parseArgs` rejects `--ready`; unknown commands print usage and exit 2).

- [ ] **Step 3: Implement in `harness/cli.mjs`**

Update imports:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectNext, targetsToCheck } from './lib/queue.mjs';
import { loadConfig } from './lib/config.mjs';
```

Add to `USAGE`:

```
  cli.mjs select --issues <f> --prs <f> --default-branch <b> [--ready <f>]
  cli.mjs target-info --config <f> --selection <f> --out <dir>
  cli.mjs targets-to-check --ready <f>
  cli.mjs render-comment --verdict <f> --run-url <u> [--pr-url <u>] [--target-prs <f>]
```

(replacing the existing `select` and `render-comment` lines).

Add to the `parseArgs` options: `ready: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' }, 'target-prs': { type: 'string' },`.

Replace the `select` case with:

```js
  case 'select':
    print(selectNext({
      issues: read(values.issues), prs: read(values.prs), defaultBranch: values['default-branch'],
      ready: values.ready ? read(values.ready) : [],
    }));
    break;
```

Replace the `render-comment` case with:

```js
  case 'render-comment':
    process.stdout.write(renderComment(read(values.verdict), {
      runUrl: values['run-url'], prUrl: values['pr-url'],
      targetPrs: values['target-prs'] ? read(values['target-prs']) : undefined,
    }));
    break;
```

Add before `default:`:

```js
  case 'target-info': {
    let target = null;
    try {
      target = loadConfig(readFileSync(values.config, 'utf8')).target;
    } catch {
      // run-task reports an invalid config itself
    }
    if (!target) break;
    if (process.env.HAS_TARGET_READ_TOKEN !== 'true' || process.env.HAS_TARGET_PUSH_TOKEN !== 'true') {
      writeFileSync(join(values.out, 'target-checkout.txt'), 'target configured but TARGET_READ_TOKEN or TARGET_PUSH_TOKEN secret missing\n');
      break;
    }
    const selection = read(values.selection);
    process.stdout.write(`repo=${target.repo}\npath=${target.path}\nref=${selection.targets?.superBranch ?? ''}\n`);
    break;
  }
  case 'targets-to-check':
    print(targetsToCheck(read(values.ready)));
    break;
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/cli.test.mjs` — Expected: PASS.

- [ ] **Step 5: Full suite and commit**

Run: `npm test` — Expected: PASS.

```bash
git add harness/cli.mjs test/cli.test.mjs
git commit -m "feat: CLI commands for target checkout, stacking and merge checks"
```

---

## Task 10: Publish target bundles as draft PRs

**Files:**
- Create: `harness/publish-targets.mjs`
- Modify: `harness/publish.sh`
- Modify: `test/stubs/gh` (two new cases; existing behaviour unchanged)
- Create: `test/helpers/publish-targets-fixture.mjs`
- Test: `test/publish-targets.test.mjs`

**Interfaces:**
- Consumes: `verdict.targets` (Task 8), `BRANCH_RE`, `RELATED_TOKEN` (Task 2), `render-comment --target-prs` (Task 9).
- Produces:
  - `node harness/publish-targets.mjs --verdict <f> --bundle-dir <dir> --out <f>` — env `TARGET_PUSH_TOKEN`, optional `TARGET_PUSH_REMOTE_TEMPLATE` (default `https://x-access-token:<token>@github.com/{repo}.git`). Writes `<out>` after every opened PR: `Array<{ repo, role, number, url, branch, base }>`. Exit 1 with stderr `target publish failed at <stage> for <repo>: <message>`.
  - `publish.sh` reads `BUNDLE_DIR` and `TARGET_PUSH_TOKEN`; without `verdict.targets` it behaves exactly as before.

- [ ] **Step 1: Extend the gh stub** — in `test/stubs/gh`, replace the `case` block with:

```sh
case "$1 $2" in
  "pr create")
    if [ -n "$GH_FAIL_PR_CREATE" ]; then echo "pull request create failed" >&2; exit 1; fi
    if [ -n "$GH_FAIL_PR_CREATE_REPO" ] && echo "$*" | grep -q -- "--repo $GH_FAIL_PR_CREATE_REPO "; then echo "pull request create failed" >&2; exit 1; fi
    echo "https://github.com/o/r/pull/9" ;;
  "pr list")
    [ -n "$GH_PR_LIST" ] && echo "$GH_PR_LIST" ;;
  "repo view")
    echo "main" ;;
esac
```

Run: `npm test` — Expected: PASS (existing publish tests unaffected; `GH_PR_LIST` and `GH_FAIL_PR_CREATE_REPO` are unset there).

- [ ] **Step 2: Write `test/helpers/publish-targets-fixture.mjs`**

```js
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RELATED_TOKEN } from '../../harness/lib/target.mjs';

const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Remote at <dir>/remotes/<owner>/<name>.git with one base commit, plus a thin bundle of
// one task commit on `branch`. Returns the verdict.targets entry.
function makeRepo(dir, repo, role, branch) {
  const remote = join(dir, 'remotes', `${repo}.git`);
  mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const work = join(dir, 'work', repo);
  mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'base.txt'), 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  git(work, 'push', '-q', remote, 'main');
  const baseSha = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', branch);
  writeFileSync(join(work, 'change.txt'), `${repo}\n`);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'task');
  const bundle = `bundles/${repo.replace('/', '__')}.bundle`;
  mkdirSync(join(dir, 'bundles'), { recursive: true });
  git(work, 'bundle', 'create', join(dir, bundle), `${baseSha}..refs/heads/${branch}`);
  // A hook in the agent's repository must never run while publishing.
  writeFileSync(join(work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\ntouch "$HOOK_RAN"\n', { mode: 0o755 });
  return {
    repo, path: role === 'super' ? 'target' : 'target/sub', role, branch, base: null, baseSha, commits: 1, bundle,
    prTitle: `Title ${repo}`, prBody: `Body ${repo}\n${RELATED_TOKEN}\n`,
  };
}

export function makeTargetsFixture({ branch = 'fix/x' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-targets-'));
  const targets = [makeRepo(dir, 'o/sub', 'sub', branch), makeRepo(dir, 'o/super', 'super', branch)];
  return { dir, targets, remoteTemplate: `file://${dir}/remotes/{repo}.git` };
}

export const remoteHasBranch = (dir, repo, branch) =>
  execFileSync('git', ['-C', join(dir, 'remotes', `${repo}.git`), 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== '';
```

- [ ] **Step 3: Write the failing tests `test/publish-targets.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTargetsFixture, remoteHasBranch } from './helpers/publish-targets-fixture.mjs';
import { parseTargetsMarker } from '../harness/lib/target.mjs';

const SCRIPT = new URL('../harness/publish-targets.mjs', import.meta.url).pathname;
const PUBLISH = new URL('../harness/publish.sh', import.meta.url).pathname;
const STUBS = new URL('./stubs', import.meta.url).pathname;

const readyVerdict = (targets) => ({
  outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings: [],
  issue: 7, issueTitle: 'Task 1', plan: 'docs/p.md', task: 1, taskTitle: 'Add greeting',
  baseBranch: 'main', branch: 'agent/issue-7', model: 'sonnet', commits: 2, consumerCommits: 0,
  checks: {}, report: { summary: 's', selfReview: 'r', knownIssues: 'None' }, reportText: '', targets,
});

function env(dir, remoteTemplate, extra = {}) {
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  return {
    log,
    env: {
      ...process.env, PATH: `${STUBS}:${process.env.PATH}`, GH_LOG: log,
      TARGET_PUSH_TOKEN: 'tok', TARGET_PUSH_REMOTE_TEMPLATE: remoteTemplate, HOOK_RAN: join(dir, 'hook-ran'), ...extra,
    },
  };
}

function runScript(extra = {}) {
  const fx = makeTargetsFixture();
  writeFileSync(join(fx.dir, 'verdict.json'), JSON.stringify(readyVerdict(fx.targets)));
  const { log, env: e } = env(fx.dir, fx.remoteTemplate, extra);
  const out = join(fx.dir, 'prs.json');
  const r = spawnSync(process.execPath, [SCRIPT, '--verdict', join(fx.dir, 'verdict.json'), '--bundle-dir', fx.dir, '--out', out], { encoding: 'utf8', env: e });
  return { ...fx, r, out, log: readFileSync(log, 'utf8') };
}

test('pushes submodules before the superproject and opens draft PRs', () => {
  const { r, dir, out, log } = runScript();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(remoteHasBranch(dir, 'o/sub', 'fix/x'));
  assert.ok(remoteHasBranch(dir, 'o/super', 'fix/x'));
  const creates = log.split('\n').filter((l) => l.startsWith('gh pr create'));
  assert.equal(creates.length, 2);
  assert.match(creates[0], /--draft --repo o\/sub --base main --head fix\/x --title Title o\/sub/);
  assert.match(creates[1], /--repo o\/super /);
  assert.match(log, /gh pr edit 9 --repo o\/sub --body-file/);
  assert.match(log, /- o\/super#9/);
  assert.doesNotMatch(log, /agent-related/);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).map((p) => [p.repo, p.role, p.number, p.base]), [['o/sub', 'sub', 9, 'main'], ['o/super', 'super', 9, 'main']]);
  assert.equal(existsSync(join(dir, 'hook-ran')), false);
});

test('an existing PR is edited, not duplicated', () => {
  const { r, log } = runScript({ GH_PR_LIST: '{"number":45,"url":"https://github.com/o/sub/pull/45"}' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(log, /gh pr create/);
  assert.match(log, /gh pr edit 45 --repo o\/sub --base main --title Title o\/sub/);
});

test('a failure after one PR lists the opened PR', () => {
  const { r, out } = runScript({ GH_FAIL_PR_CREATE_REPO: 'o/super' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /target publish failed at pr for o\/super/);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).map((p) => p.repo), ['o/sub']);
});

test('refuses an unsafe branch name', () => {
  const fx = makeTargetsFixture();
  const targets = fx.targets.map((t) => ({ ...t, branch: 'x;rm' }));
  writeFileSync(join(fx.dir, 'verdict.json'), JSON.stringify(readyVerdict(targets)));
  const { env: e } = env(fx.dir, fx.remoteTemplate);
  const r = spawnSync(process.execPath, [SCRIPT, '--verdict', join(fx.dir, 'verdict.json'), '--bundle-dir', fx.dir, '--out', join(fx.dir, 'o.json')], { encoding: 'utf8', env: e });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing branch name "x;rm"/);
});

function runPublish(verdictOverrides, extra = {}) {
  const fx = makeTargetsFixture();
  const verdict = { ...readyVerdict(fx.targets), ...verdictOverrides(fx.targets) };
  writeFileSync(join(fx.dir, 'verdict.json'), JSON.stringify(verdict));
  const { log, env: e } = env(fx.dir, fx.remoteTemplate, {
    VERDICT: join(fx.dir, 'verdict.json'), REPO: 'o/r', GH_TOKEN: 'x', RUN_URL: 'https://run',
    BUNDLE: join(fx.dir, 'branch.bundle'), BUNDLE_DIR: fx.dir, PUSH_REMOTE: join(fx.dir, 'none.git'), ...extra,
  });
  const r = spawnSync('bash', [PUBLISH], { encoding: 'utf8', env: e });
  return { ...fx, r, log: readFileSync(log, 'utf8') };
}

test('publish.sh: READY with targets and no consumer commits opens only target PRs and comments the marker', () => {
  const { r, log } = runPublish(() => ({}));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(log, /gh pr create .*--repo o\/r /);
  assert.match(log, /--add-label agent:ready/);
  const marker = parseTargetsMarker(log);
  assert.deepEqual(marker.map((p) => [p.repo, p.role]), [['o/sub', 'sub'], ['o/super', 'super']]);
});

test('publish.sh: BLOCKED with targets pushes nothing to target repositories', () => {
  const { r, dir, log } = runPublish(() => ({ outcome: 'BLOCKED', kind: 'gate', reasons: ['x'], report: null }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteHasBranch(dir, 'o/super', 'fix/x'), false);
  assert.match(log, /were not pushed; their bundles are in the run artifact/);
});

test('publish.sh: a target failure ends BLOCKED and lists PRs already opened', () => {
  const { r, log } = runPublish(() => ({}), { GH_FAIL_PR_CREATE_REPO: 'o/super' });
  assert.notEqual(r.status, 0);
  assert.match(log, /--add-label agent:blocked/);
  assert.match(log, /publishing failed at step: targets/);
  assert.match(log, /Opened before the failure:\n- `o\/sub` #9: https:\/\/github\.com\/o\/r\/pull\/9/);
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `node --test test/publish-targets.test.mjs` — Expected: FAIL (`publish-targets.mjs` missing).

- [ ] **Step 5: Write `harness/publish-targets.mjs`**

```js
#!/usr/bin/env node
// Pushes each target repository's thin bundle and opens or updates a draft PR in it.
// Runs in the publish job: no agent ever ran on this VM, and hooks are disabled.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BRANCH_RE, RELATED_TOKEN } from './lib/target.mjs';

const { values } = parseArgs({ options: { verdict: { type: 'string' }, 'bundle-dir': { type: 'string' }, out: { type: 'string' } } });
const verdict = JSON.parse(readFileSync(values.verdict, 'utf8'));
const token = process.env.TARGET_PUSH_TOKEN ?? '';
const remoteFor = (repo) =>
  (process.env.TARGET_PUSH_REMOTE_TEMPLATE ?? `https://x-access-token:${token}@github.com/{repo}.git`).replace('{repo}', repo);
const gh = (...args) => execFileSync('gh', args, { env: { ...process.env, GH_TOKEN: token }, encoding: 'utf8' }).trim();
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const opened = [];
const save = () => writeFileSync(values.out, JSON.stringify(opened.map(({ body, work, ...p }) => p), null, 2));
let stage = 'start';
let current = '';

try {
  for (const t of verdict.targets.filter((x) => x.commits > 0)) {
    current = t.repo;
    stage = 'push';
    if (!BRANCH_RE.test(t.branch) || (t.base !== null && !BRANCH_RE.test(t.base))) throw new Error(`refusing branch name "${t.branch}"`);
    const work = mkdtempSync(join(tmpdir(), 'target-publish-'));
    git(work, 'init', '-q');
    git(work, 'fetch', '-q', '--depth=1', remoteFor(t.repo), t.baseSha);
    git(work, 'fetch', '-q', resolve(values['bundle-dir'], t.bundle), `refs/heads/${t.branch}:refs/heads/${t.branch}`);
    git(work, 'push', '-q', '--force', remoteFor(t.repo), `refs/heads/${t.branch}:refs/heads/${t.branch}`);

    stage = 'pr';
    const base = t.base ?? gh('repo', 'view', t.repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name');
    const bodyFile = join(work, 'body.md');
    writeFileSync(bodyFile, t.prBody.replaceAll(RELATED_TOKEN, ''));
    const existing = gh('pr', 'list', '--repo', t.repo, '--head', t.branch, '--state', 'open', '--json', 'number,url', '-q', '.[0] // empty');
    let pr;
    if (existing) {
      pr = JSON.parse(existing);
      gh('pr', 'edit', String(pr.number), '--repo', t.repo, '--base', base, '--title', t.prTitle, '--body-file', bodyFile);
    } else {
      const url = gh('pr', 'create', '--draft', '--repo', t.repo, '--base', base, '--head', t.branch, '--title', t.prTitle, '--body-file', bodyFile);
      pr = { number: Number(url.split('/').pop()), url };
    }
    opened.push({ repo: t.repo, role: t.role, number: pr.number, url: pr.url, branch: t.branch, base, body: t.prBody, work });
    save();
  }

  stage = 'related';
  if (opened.length > 1) {
    for (const p of opened) {
      current = p.repo;
      const related = opened.filter((o) => o !== p).map((o) => `- ${o.repo}#${o.number}`).join('\n');
      const bodyFile = join(p.work, 'body.md');
      writeFileSync(bodyFile, p.body.replaceAll(RELATED_TOKEN, `## Related\n${related}`));
      gh('pr', 'edit', String(p.number), '--repo', p.repo, '--body-file', bodyFile);
    }
  }
  save();
} catch (e) {
  const detail = String(e.stderr || e.message).split('\n').find(Boolean) ?? 'unknown error';
  console.error(`target publish failed at ${stage} for ${current}: ${detail}`);
  process.exit(1);
}
```

- [ ] **Step 6: Integrate into `harness/publish.sh`**

After the `CLI=…` line add:

```bash
PUBLISH_TARGETS="$(cd "$(dirname "$0")" && pwd)/publish-targets.mjs"
BUNDLE_DIR="${BUNDLE_DIR:-}"
```

In `on_error`, directly after the `printf … > "$TMP/fail.md"` line, add:

```bash
  if [ -s "$TMP/target-prs.json" ]; then
    { echo; echo "Opened before the failure:"; jq -r '.[] | "- `\(.repo)` #\(.number): \(.url)"' "$TMP/target-prs.json"; } >> "$TMP/fail.md"
  fi
```

After `has_bundle() { … }` add:

```bash
has_targets() { [ "$(jq -r '(.targets // []) | map(select(.commits > 0)) | length' "$VERDICT")" -gt 0 ]; }
```

Replace the READY branch's first lines:

```bash
if [ "$outcome" = "READY_FOR_QA" ]; then
  stage="bundle"
  has_bundle
  push_branch
  stage="pr"
```

through the end of its `fi` for the PR create/edit with:

```bash
if [ "$outcome" = "READY_FOR_QA" ]; then
  if has_targets; then
    stage="targets"
    node "$PUBLISH_TARGETS" --verdict "$VERDICT" --bundle-dir "$BUNDLE_DIR" --out "$TMP/target-prs.json"
  fi
  if has_bundle || ! has_targets; then
    stage="bundle"
    has_bundle
    push_branch
    stage="pr"
    node "$CLI" render-pr --verdict "$VERDICT" > "$TMP/body.md"
    pr=$(gh pr list --repo "$REPO" --head "$branch" --state open --json url -q '.[0].url // empty')
    if [ -n "$pr" ]; then
      gh pr edit "$pr" --repo "$REPO" --base "$base" --title "Task ${task}: ${title}" --body-file "$TMP/body.md" >/dev/null
    else
      pr=$(gh pr create --repo "$REPO" --base "$base" --head "$branch" --title "Task ${task}: ${title}" --body-file "$TMP/body.md")
    fi
  fi
```

(the `stage="label-outcome"` / `agent:ready` lines that follow stay as they are).

Replace the comment rendering block:

```bash
stage="comment"
if [ -n "$pr" ]; then
  node "$CLI" render-comment --verdict "$VERDICT" --run-url "$RUN_URL" --pr-url "$pr" > "$TMP/comment.md"
else
  node "$CLI" render-comment --verdict "$VERDICT" --run-url "$RUN_URL" > "$TMP/comment.md"
fi
```

with:

```bash
stage="comment"
args=(--verdict "$VERDICT" --run-url "$RUN_URL")
[ -n "$pr" ] && args+=(--pr-url "$pr")
[ -s "$TMP/target-prs.json" ] && args+=(--target-prs "$TMP/target-prs.json")
node "$CLI" render-comment "${args[@]}" > "$TMP/comment.md"
```

- [ ] **Step 7: Run to verify they pass**

Run: `node --test test/publish-targets.test.mjs test/publish.test.mjs test/compat.test.mjs`
Expected: PASS. `test/compat.test.mjs` proves the consumer-only publish log is unchanged.
If the bundle fetch fails with `Repository lacks these prerequisite commits` or a shallow-history error, the `--depth=1` base fetch is not enough for the thin bundle on this git version: drop `--depth=1` from the base fetch (fetch `t.baseSha` with full history) and re-run. Do not switch to full bundles; they would put the target's whole history in the run artifact.

- [ ] **Step 8: Full suite and commit**

Run: `npm test` — Expected: PASS.

```bash
git add harness/publish-targets.mjs harness/publish.sh test/stubs/gh test/helpers/publish-targets-fixture.mjs test/publish-targets.test.mjs
git commit -m "feat: publish target bundles as draft PRs"
```

---

## Task 11: Workflow, caller template and README

_Manual: `.github/**` is protected, so an agent run would always end BLOCKED._

**Files:**
- Modify: `.github/workflows/run-task.yml`
- Modify: `templates/agent.yml`
- Modify: `README.md`
- Test: `test/templates.test.mjs` (append only)

**Interfaces:**
- Consumes: CLI commands (Task 9), `publish-targets.mjs` via `publish.sh` (Task 10), `run-task.mjs --selection` (Task 7).
- Produces: optional `workflow_call` secrets `TARGET_READ_TOKEN`, `TARGET_PUSH_TOKEN`.

- [ ] **Step 1: Append failing tests**

```js
const step = (yaml, name) => {
  const start = yaml.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `step "${name}" missing`);
  const next = yaml.indexOf('\n      - name:', start + 1);
  return yaml.slice(start, next === -1 ? undefined : next);
};

test('target secrets are optional workflow_call secrets', () => {
  const y = read('.github/workflows/run-task.yml');
  assert.match(y, /TARGET_READ_TOKEN:\n\s+required: false/);
  assert.match(y, /TARGET_PUSH_TOKEN:\n\s+required: false/);
});

test('the Run task step carries no target secret', () => {
  const y = read('.github/workflows/run-task.yml');
  assert.doesNotMatch(step(y, 'Run task'), /TARGET_/);
  assert.match(step(y, 'Run task'), /--selection "\$RUNNER_TEMP\/agent\/selection\.json"/);
});

test('the target checkout uses the read token without persisting it and records failure', () => {
  const y = read('.github/workflows/run-task.yml');
  const s = step(y, 'Checkout target');
  assert.match(s, /token: \$\{\{ secrets\.TARGET_READ_TOKEN \}\}/);
  assert.match(s, /persist-credentials: false/);
  assert.match(s, /submodules: recursive/);
  assert.match(s, /continue-on-error: true/);
  assert.match(step(y, 'Record target checkout failure'), /target checkout failed/);
});

test('publish gets the push token and the bundle directory; select closes merged target tasks', () => {
  const y = read('.github/workflows/run-task.yml');
  const p = step(y, 'Publish result');
  assert.match(p, /TARGET_PUSH_TOKEN: \$\{\{ secrets\.TARGET_PUSH_TOKEN \}\}/);
  assert.match(p, /BUNDLE_DIR/);
  const c = step(y, 'Close tasks whose target PR merged');
  assert.match(c, /\[ -n "\$TARGET_TOKEN" \] \|\| exit 0/);
  assert.match(c, /targets-to-check/);
  assert.match(c, /--reason completed/);
  assert.match(step(y, 'Select next task'), /--ready /);
});

test('the caller template mentions the target secrets only as comments', () => {
  const y = read('templates/agent.yml');
  assert.match(y, /# TARGET_READ_TOKEN: \$\{\{ secrets\.TARGET_READ_TOKEN \}\}/);
  assert.match(y, /# TARGET_PUSH_TOKEN: \$\{\{ secrets\.TARGET_PUSH_TOKEN \}\}/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/templates.test.mjs` — Expected: FAIL (`step "Checkout target" missing`, …).

- [ ] **Step 3: Edit `.github/workflows/run-task.yml`**

Under `on.workflow_call.secrets`, after `CLAUDE_CODE_OAUTH_TOKEN_2`, add:

```yaml
      # Optional: tasks that change a separate target repository (agent.config.json "target").
      TARGET_READ_TOKEN:
        required: false
      TARGET_PUSH_TOKEN:
        required: false
```

In job `select`, after the "Ensure labels" step, add:

```yaml
      - name: Close tasks whose target PR merged
        env:
          GH_TOKEN: ${{ github.token }}
          TARGET_TOKEN: ${{ secrets.TARGET_PUSH_TOKEN }}
        run: |
          [ -n "$TARGET_TOKEN" ] || exit 0
          gh issue list --repo "$GITHUB_REPOSITORY" --state open --label agent:ready --limit 100 --json number,body,comments > "$RUNNER_TEMP/ready-close.json"
          node "$GITHUB_WORKSPACE/.harness/harness/cli.mjs" targets-to-check --ready "$RUNNER_TEMP/ready-close.json" | jq -c '.[]' | while read -r t; do
            state=$(GH_TOKEN="$TARGET_TOKEN" gh pr view "$(jq -r .number <<<"$t")" --repo "$(jq -r .repo <<<"$t")" --json state -q .state || echo UNKNOWN)
            if [ "$state" = "MERGED" ]; then
              gh issue close "$(jq -r .issue <<<"$t")" --repo "$GITHUB_REPOSITORY" --reason completed
            fi
          done
```

In the "Select next task" step, after the `gh pr list … > prs.json` line add:

```bash
          gh issue list --repo "$GITHUB_REPOSITORY" --state open --label agent:ready --limit 100 --json number,body,comments > ready.json
```

and change the `select` invocation to end with `--default-branch "$default" --ready ready.json > selection.json`.

In job `run`, after "Read config from the default branch", add:

```yaml
      - name: Target info
        id: target
        env:
          HAS_TARGET_READ_TOKEN: ${{ secrets.TARGET_READ_TOKEN != '' }}
          HAS_TARGET_PUSH_TOKEN: ${{ secrets.TARGET_PUSH_TOKEN != '' }}
        run: >-
          node .harness/harness/cli.mjs target-info
          --config "$RUNNER_TEMP/agent/default.agent.config.json"
          --selection "$RUNNER_TEMP/agent/selection.json"
          --out "$RUNNER_TEMP/agent" >> "$GITHUB_OUTPUT"

      # The read token lives in this step only: not on disk, not in the agent's environment.
      - name: Checkout target
        id: checkout_target
        if: steps.target.outputs.repo != ''
        continue-on-error: true
        uses: actions/checkout@v4
        with:
          repository: ${{ steps.target.outputs.repo }}
          ref: ${{ steps.target.outputs.ref }}
          token: ${{ secrets.TARGET_READ_TOKEN }}
          submodules: recursive
          fetch-depth: 0
          path: project/${{ steps.target.outputs.path }}
          persist-credentials: false

      - name: Record target checkout failure
        if: steps.checkout_target.outcome == 'failure'
        run: echo "target checkout failed" > "$RUNNER_TEMP/agent/target-checkout.txt"
```

In the "Run task" step's `run`, add a line after `--config "$RUNNER_TEMP/agent/default.agent.config.json"`:

```
          --selection "$RUNNER_TEMP/agent/selection.json"
```

In the "Publish result" step's `env`, add:

```yaml
          TARGET_PUSH_TOKEN: ${{ secrets.TARGET_PUSH_TOKEN }}
```

and in its `run`, after `export BUNDLE=…`, add:

```bash
          export BUNDLE_DIR="$RUNNER_TEMP/agent"
```

- [ ] **Step 4: Edit `templates/agent.yml`** — after the `CLAUDE_CODE_OAUTH_TOKEN_2` line add:

```yaml
      # Optional: tasks that change a separate target repository (README, "Target repositories").
      # TARGET_READ_TOKEN: ${{ secrets.TARGET_READ_TOKEN }}
      # TARGET_PUSH_TOKEN: ${{ secrets.TARGET_PUSH_TOKEN }}
```

- [ ] **Step 5: Add a README section** before "## Usage limits and a second account":

````markdown
## Target repositories

A task can change a repository other than the one that queues it — for example a superproject with private submodules that must not contain harness files. Add `target` to `agent.config.json`:

```json
{
  "target": {
    "repo": "owner/superproject",
    "path": "target",
    "branch": "{type}/{slug}",
    "pr": { "title": "{taskTitle}", "body": ".github/agent-pr-body.md" },
    "author": { "name": "Jane Doe", "email": "jane@example.com" }
  }
}
```

- `path` must be git-ignored in the consumer (`target/` in `.gitignore`). Checks run from the consumer root and can `cd` into it. Set `testGlobs` to include target tests, e.g. `"target/**/*.spec.ts"`.
- `branch` variables: `{type}` (from a `feat:`/`fix:`/`chore:`/`refactor:`/`test:`/`docs:`/`perf:` prefix of the task title, default `fix`), `{slug}`, `{issue}`, `{task}`.
- PR template variables: `{taskTitle}`, `{task}`, `{issue}`, `{summary}`, `{changedFiles}`, `{checks}`, `{related}`. The default body has no link back to the consumer.
- Secrets: `TARGET_READ_TOKEN` (clones the superproject and submodules) and `TARGET_PUSH_TOKEN` (pushes branches, opens draft PRs, checks merges); uncomment both lines in `agent.yml`. They may be the same token.

Each changed repository gets a **draft** PR with the same branch name; submodules are pushed before the superproject, which must point at the submodule commits. The task issue's READY comment lists the PRs and carries an `agent-targets` marker: later tasks of the same plan stack on those branches, and the issue closes when the superproject PR merges. A BLOCKED task pushes nothing to target repositories; its bundles stay in the run artifact for 14 days.

The run job holds `TARGET_READ_TOKEN` during one clone step (masked, never written to disk, never in the agent's environment); prefer a read-only token there.
````

- [ ] **Step 6: Run to verify they pass**

Run: `node --test test/templates.test.mjs` — Expected: PASS.

- [ ] **Step 7: Full suite and commit**

Run: `npm test` — Expected: PASS.

```bash
git add .github/workflows/run-task.yml templates/agent.yml README.md test/templates.test.mjs
git commit -m "feat: target checkout, publish and merge sweep in the reusable workflow"
```

---

## Task 12: Release as v2 (interactive — needs the user's go-ahead at each step)

No code. `v1` must not move.

- [ ] **Step 1:** Open a PR for the branch and wait for CI (`npm test`) to pass. Ask the user to merge it.
- [ ] **Step 2:** Ask the user before tagging. Then: `git checkout main && git pull && git tag v2 && git push origin v2`. Confirm `git rev-parse v1` still prints `d969ea7da7d48057483a7ceefa0fb113c3966447`.
- [ ] **Step 3: Target consumer.** In the consumer that needs a target (outside this repo): pin `uses: …/run-task.yml@v2` and `harness_ref: v2`, add `target` to its config and `target/` to `.gitignore`, set both secrets, queue one small task. Expected: draft PRs in each changed repository, an issue comment with the `agent-targets` marker.
- [ ] **Step 4: Existing consumer smoke.** In one existing consumer without `target`, temporarily pin `@v2` / `harness_ref: v2`, queue one small task. Expected: the same PR shape as under `v1` (branch `agent/issue-<n>`, marker, `Closes #n`). Revert the pin afterwards.
- [ ] **Step 5:** Report both runs to the user. Moving `v1` is a separate decision for them.
