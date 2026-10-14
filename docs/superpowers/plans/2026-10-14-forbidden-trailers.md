# Forbidden Commit Trailers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A consumer can forbid commit trailers (for example `Co-Authored-By`) in agent commits. Agents are told, and a commit that still carries one blocks the task, or is reverted when a review fixer made it.

**Architecture:** `harness/lib/config.mjs` gains `forbiddenTrailers` (default `[]`). `harness/lib/gate.mjs` gains `trailerViolations(commits, forbidden)`, and `decide` / `diffViolations` take its result as `commitErrors`. `harness/lib/agent.mjs` gains `trailersRule(forbidden)`, appended to the implementer prompt and the review fixer prompt. `harness/run-task.mjs` reads the commit messages of the consumer and every target repository.

**Tech Stack:** Node ≥ 22, ES modules, `node:test`, bash. No dependencies.

**Spec:** none; this closes a gap found in practice: a plan's "no trailers" constraint was ignored on 2 of 6 agent commits. Projects that require trailers (for example `Signed-off-by`) must stay unaffected, so the rule is opt-in.

**Execution:** Task 1 runs as an agent task (label `agent`).

## Global Constraints

- No new dependencies. Existing tests are never edited; new cases go in a new file. `test/compat.test.mjs` must pass.
- **Compatibility:** without `forbiddenTrailers` (or with `[]`) prompts, verdicts and outcomes are byte-identical to today.
- **Generic:** no project, company or repository names in code, tests or docs.
- Commits: conventional messages, no trailers.
- Config: `forbiddenTrailers`, array of trailer keys matching `^[A-Za-z][A-Za-z0-9-]*$`, matched case-insensitively against lines `<Key>: <value>` in commit messages. Error text: `"forbiddenTrailers" must be an array of trailer names like "Co-Authored-By"`.
- Gate reason, verbatim: `commit messages carry forbidden trailers: <short shas, comma-separated>`. Outcome `BLOCKED`, kind `gate`. In the review loop the same reason reverts the fix with exit `gate`.
- Prompt section, verbatim (appended only when the list is non-empty):

```

## Commit messages

Do not add these trailers to any commit message: <keys joined by ", ">. Commits that carry them are rejected.
```

## Review Focus

- **A body line that only looks like a trailer key** (`Note: x` when only `Co-Authored-By` is forbidden). Expected: not a violation. (Test `only forbidden keys count`.)
- **A forbidden trailer in a target repository commit.** Expected: blocked like a consumer commit. (Test `a trailer in a target repository blocks`.)
- **Lower-case key in the message** (`co-authored-by:`). Expected: still caught. (Test `keys match case-insensitively`.)

---

## Task 1: feat: forbidden commit trailers

**Files:**
- Modify: `harness/lib/config.mjs`
- Modify: `harness/lib/gate.mjs`
- Modify: `harness/lib/agent.mjs`
- Modify: `harness/lib/review-loop.mjs`
- Modify: `harness/run-task.mjs`
- Modify: `README.md`
- Create: `test/fake-agents/honest-trailer.sh`
- Create: `test/fake-agents/fix-trailer.sh`
- Create: `test/fake-agents/target-trailer.sh`
- Test: `test/trailers.test.mjs`

**Interfaces:**
- Produces: `loadConfig(text).forbiddenTrailers` → `string[]`; `trailerViolations(commits: { sha, body }[], forbidden: string[])` → `string[]` from `harness/lib/gate.mjs`; `decide({ ..., commitErrors = [] })` and `diffViolations({ ..., commitErrors = [] })`; `trailersRule(forbidden)` → string from `harness/lib/agent.mjs`; `runReviewLoop` option `promptSuffix` (renamed from `targetSection`).

- [ ] **Step 1: Add the fake agents** — `test/fake-agents/honest-trailer.sh`:

```sh
set -e
. "$(dirname "$0")/lib.sh"
echo hello > greeting.txt
echo 'test "$(cat greeting.txt)" = "hello"' > tests/greeting.test.sh
git add -A
git commit -qm "Add greeting

Co-Authored-By: Someone <someone@example.com>"
ready_report greeting.txt tests/greeting.test.sh
```

`test/fake-agents/fix-trailer.sh`:

```sh
echo "note" >> notes.txt
git add notes.txt
git commit -qm "fix: address review round $AGENT_REVIEW_ROUND

co-authored-by: Someone <someone@example.com>"
echo "R1: FIXED" > "$AGENT_OUTPUT_PATH"
```

`test/fake-agents/target-trailer.sh`:

```sh
set -e
. "$(dirname "$0")/lib.sh"
cd target/packages/core
echo b > lib.txt
git add -A
git commit -qm "Change lib

Co-Authored-By: Someone <someone@example.com>"
cd ../..
git add packages/core
git commit -qm "Point at the new lib"
cd ..
ready_report target/packages/core/lib.txt target/packages/core
```

- [ ] **Step 2: Write the failing tests** — create `test/trailers.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../harness/lib/config.mjs';
import { trailerViolations } from '../harness/lib/gate.mjs';
import { trailersRule } from '../harness/lib/agent.mjs';
import { runTask } from '../harness/run-task.mjs';
import { runTarget } from './helpers/target-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, 'fake-agents');
const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const FORBID = ['Co-Authored-By'];

test('config: default empty, values kept, invalid rejected', () => {
  const base = { install: 'x', checks: { t: 'y' } };
  assert.deepEqual(loadConfig(JSON.stringify(base)).forbiddenTrailers, []);
  assert.deepEqual(loadConfig(JSON.stringify({ ...base, forbiddenTrailers: FORBID })).forbiddenTrailers, FORBID);
  for (const bad of ['x', [''], ['Co Authored'], ['-x'], [3]]) {
    assert.throws(() => loadConfig(JSON.stringify({ ...base, forbiddenTrailers: bad })), /"forbiddenTrailers" must be an array of trailer names like "Co-Authored-By"/);
  }
});

test('only forbidden keys count', () => {
  const commits = [{ sha: 'aaaaaaa1', body: 'Add x\n\nNote: this is fine\nSigned-off-by: A <a@b>' }];
  assert.deepEqual(trailerViolations(commits, FORBID), []);
  assert.deepEqual(trailerViolations(commits, []), []);
});

test('keys match case-insensitively', () => {
  const commits = [
    { sha: 'aaaaaaa1111', body: 'Add x\n\nco-authored-by: A <a@b>' },
    { sha: 'bbbbbbb2222', body: 'Add y' },
    { sha: 'ccccccc3333', body: 'Add z\n\nCo-Authored-By: B <b@c>' },
  ];
  assert.deepEqual(trailerViolations(commits, FORBID), ['commit messages carry forbidden trailers: aaaaaaa, ccccccc']);
});

test('prompt rule only when configured', () => {
  assert.equal(trailersRule([]), '');
  assert.equal(trailersRule(['Co-Authored-By', 'Signed-off-by']),
    '\n\n## Commit messages\n\nDo not add these trailers to any commit message: Co-Authored-By, Signed-off-by. Commits that carry them are rejected.\n');
});

function project(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'trailers-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  mkdirSync(join(dir, 'skill'), { recursive: true });
  writeFileSync(join(dir, 'skill', 'SKILL.md'), '# Fixture review skill\n');
  const path = join(dir, 'agent.config.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...extra }, null, 2));
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

async function run(agent, extra, env = {}) {
  const projectDir = project(extra);
  const outDir = mkdtempSync(join(tmpdir(), 'trailers-out-'));
  const verdict = await runTask({
    projectDir, issue: ISSUE, outDir, baseBranch: 'main', env: { ...process.env, AGENT_CMD: `sh "${join(AGENTS, agent)}"`, ...env },
  });
  return { verdict, prompt: readFileSync(join(outDir, 'prompt.md'), 'utf8') };
}

test('a forbidden trailer blocks the task and the prompt names it', async () => {
  const { verdict, prompt } = await run('honest-trailer.sh', { forbiddenTrailers: FORBID });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'gate');
  assert.match(verdict.reasons[0], /^commit messages carry forbidden trailers: [0-9a-f]{7}$/);
  assert.match(prompt, /## Commit messages\n\nDo not add these trailers to any commit message: Co-Authored-By\./);
});

test('without the setting trailers are allowed and the prompt is unchanged', async () => {
  const { verdict, prompt } = await run('honest-trailer.sh', {});
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.doesNotMatch(prompt, /## Commit messages/);
});

test('a review fix with a forbidden trailer is reverted', async () => {
  const sh = (name) => `sh "${join(AGENTS, name)}"`;
  const { verdict } = await run('honest.sh', {
    forbiddenTrailers: FORBID, review: { skill: 'skill', maxRounds: 2, timeout: '2m', maxTurns: 5 },
  }, { AGENT_REVIEW_CMD: sh('review-stubborn.sh'), AGENT_VERIFY_CMD: sh('verify-confirm.sh'), AGENT_FIX_CMD: sh('fix-trailer.sh') });
  assert.equal(verdict.outcome, 'READY_FOR_QA');
  assert.equal(verdict.review.exit, 'gate');
  assert.match(verdict.review.error, /commit messages carry forbidden trailers/);
  assert.equal(verdict.commits, 1);
});

test('a trailer in a target repository blocks', async () => {
  const { verdict } = await runTarget({
    agent: 'target-trailer.sh',
    mutate: (dir) => {
      const path = join(dir, 'agent.config.json');
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), forbiddenTrailers: FORBID }, null, 2));
    },
  });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.match(verdict.reasons[0], /^commit messages carry forbidden trailers: /);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test test/trailers.test.mjs`
Expected: FAIL (`trailerViolations` is not exported).

- [ ] **Step 4: Config** — in `harness/lib/config.mjs` add after `stringArray`:

```js
// Trailer keys a project does not want in agent commits, e.g. Co-Authored-By. Off by default:
// some projects require trailers such as Signed-off-by.
function trailerKeys(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((k) => typeof k !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(k))) {
    throw new Error('"forbiddenTrailers" must be an array of trailer names like "Co-Authored-By"');
  }
  return [...value];
}
```

and in the object returned by `loadConfig`, after `testGlobs: ...,` add:

```js
    forbiddenTrailers: trailerKeys(raw.forbiddenTrailers),
```

- [ ] **Step 5: Gate** — in `harness/lib/gate.mjs`, add before `diffViolations`:

```js
const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):\s/;

export function trailerViolations(commits, forbidden) {
  if (!forbidden.length) return [];
  const keys = new Set(forbidden.map((k) => k.toLowerCase()));
  const hits = commits.filter((c) => c.body.split('\n').some((line) => keys.has(TRAILER.exec(line.trim())?.[1].toLowerCase())));
  return hits.length ? [`commit messages carry forbidden trailers: ${hits.map((c) => c.sha.slice(0, 7)).join(', ')}`] : [];
}
```

Change `export function diffViolations({ diff, config, pointerErrors = [] })` to `export function diffViolations({ diff, config, pointerErrors = [], commitErrors = [] })` and replace its final `return [];` with `return commitErrors;`. In `decide`, change the signature's `pointerErrors = []` to `pointerErrors = [], commitErrors = []` and the call to `diffViolations({ diff, config, pointerErrors, commitErrors })`.

- [ ] **Step 6: Prompt rule** — in `harness/lib/agent.mjs` add:

```js
export function trailersRule(forbidden) {
  if (!forbidden.length) return '';
  return `\n\n## Commit messages\n\nDo not add these trailers to any commit message: ${forbidden.join(', ')}. Commits that carry them are rejected.\n`;
}
```

- [ ] **Step 7: Review loop option** — in `harness/lib/review-loop.mjs`, rename the option `targetSection = ''` to `promptSuffix = ''` in the `runReviewLoop` parameters and change `}) + targetSection,` to `}) + promptSuffix,`.

- [ ] **Step 8: Wire it in `run-task.mjs`**:
  - add `trailersRule` to the `./lib/agent.mjs` import and `trailerViolations` to the `./lib/gate.mjs` import;
  - replace the `const fullPrompt = target ? ... : promptText;` statement with:

```js
  const fullPrompt = (target
    ? promptText + targetPromptSection({ path: config.target.path, repo: config.target.repo, branch: target.branch })
    : promptText) + trailersRule(config.forbiddenTrailers);
```

  - directly before `const decision = decide(`, add:

```js
  const commitErrors = () => {
    const logs = [{ dir: projectDir, base: baseSha }, ...(target ? target.repos.map((r) => ({ dir: r.dir, base: r.baseSha })) : [])];
    const commits = logs.flatMap(({ dir, base }) => git(dir, 'log', '--format=%H%x1f%B%x1e', `${base}..HEAD`)
      .split('\x1e').map((s) => s.trim()).filter(Boolean)
      .map((s) => { const [sha, body = ''] = s.split('\x1f'); return { sha, body }; }));
    return trailerViolations(commits, config.forbiddenTrailers);
  };
```

  - add `commitErrors: commitErrors(),` to the `decide({ ... })` argument object;
  - in the `runReviewLoop({ ... })` call, change `gateReasons` to pass `commitErrors: commitErrors()` to `diffViolations`, and replace the `targetSection: ...` line with:

```js
      promptSuffix: (target ? targetPromptSection({ path: config.target.path, repo: config.target.repo, branch: target.branch }) : '')
        + trailersRule(config.forbiddenTrailers),
```

- [ ] **Step 9: Document it** — in `README.md`, in the section that documents `agent.config.json` fields, add after the `protectedPaths` description (or at the end of that list if there is none):

```markdown
- `forbiddenTrailers`: commit trailer keys agents must not use, for example `["Co-Authored-By"]`. Agents are told; a commit that still carries one blocks the task (`gate`), and a review fix that carries one is reverted. Default: none.
```

- [ ] **Step 10: Run the tests**

Run: `node --test test/trailers.test.mjs && npm test`
Expected: all PASS, including `test/compat.test.mjs`.

- [ ] **Step 11: Commit**

```bash
git add harness/lib/config.mjs harness/lib/gate.mjs harness/lib/agent.mjs harness/lib/review-loop.mjs harness/run-task.mjs README.md test/fake-agents/honest-trailer.sh test/fake-agents/fix-trailer.sh test/fake-agents/target-trailer.sh test/trailers.test.mjs
git commit -m "feat: forbidden commit trailers"
```
