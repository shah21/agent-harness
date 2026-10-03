# Project Setup Hook and Run Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Projects can declare a `setup` command (run before baseline and before verification) and `artifacts` globs (copied into the run artifact), so checks that need running services work and their failures leave evidence.

**Architecture:** Config parsing gains three optional fields. A new pure module `harness/lib/artifacts.mjs` walks the project and copies matching files under size caps. `run-task.mjs` calls setup after each install and collects artifacts after the authoritative check phase; the verdict records what was collected and `format.mjs` mentions it. The prompt's dev-server rule becomes a template variable.

**Tech Stack:** Node ≥ 22, ES modules, `node:test`, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-setup-and-artifacts-design.md`

## Global Constraints

- No new dependencies; Node built-ins only.
- Projects that set neither `setup` nor `artifacts` must behave exactly as before (existing tests stay green unchanged, except the two default-timeout assertions in Task 1).
- `setup` and artifact collection run with `quietEnv` (project `env`, no Claude tokens).
- Default `timeouts.setup` is `5m`. Artifact caps: 50 MB total (`50 * 1024 * 1024` bytes), 2,000 files.
- Artifact collection never changes the verdict outcome.
- Blocked reasons, verbatim: `setup failed (exit N)`, `setup timed out`, `setup before verification failed (exit N)`, `setup before verification timed out` — all `kind: 'harness'`.

## Review Focus

- An agent planting files to be uploaded — collection happens only after the post-agent clean, and `<out>/artifacts` is emptied first (Task 4 test: planted file absent).
- Setup that only works once (not idempotent) or that the agent breaks — setup re-runs before verification (Task 3 test: an ignored marker removed by the clean is recreated).
- Huge report folders — caps with `TRUNCATED.txt` (Task 2 tests).
- Symlink loops or links pointing outside the project — symlinks are never followed (Task 2 test).
- Absolute or `..` globs escaping the project — rejected at config load (Task 1 test).

---

## Task 1: Config fields `setup`, `artifacts`, `timeouts.setup`

**Files:**
- Modify: `harness/lib/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `loadConfig(text)` result gains `setup: string | null`, `artifacts: string[]`, `timeouts.setup: number` (seconds).

- [ ] **Step 1: Update the two default assertions and add failing tests** in `test/config.test.mjs`

Change the `timeouts` expectation in `applies defaults` to `{ install: 900, claude: 2700, check: 600, setup: 300 }` and add after it:

```js
  assert.equal(c.setup, null);
  assert.deepEqual(c.artifacts, []);
```

Change the expectation in `partial timeouts merge with defaults` to `{ install: 900, claude: 1200, check: 600, setup: 300 }`.

Append:

```js
test('accepts setup, artifacts and a setup timeout', () => {
  const c = loadConfig(JSON.stringify({
    install: 'x', checks: { t: 'y' },
    setup: 'docker compose up -d --wait',
    artifacts: ['playwright-report/**', 'test-results/**'],
    timeouts: { setup: '2m' },
  }));
  assert.equal(c.setup, 'docker compose up -d --wait');
  assert.deepEqual(c.artifacts, ['playwright-report/**', 'test-results/**']);
  assert.equal(c.timeouts.setup, 120);
});

test('rejects a bad setup command', () => {
  const base = { install: 'x', checks: { t: 'y' } };
  assert.throws(() => loadConfig(JSON.stringify({ ...base, setup: '' })), /"setup" must be a non-empty command string/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, setup: ['a'] })), /"setup" must be a non-empty command string/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, timeouts: { setup: '5' } })), /invalid duration/);
});

test('rejects artifact globs that are not relative paths inside the project', () => {
  const base = { install: 'x', checks: { t: 'y' } };
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: 'report/**' })), /"artifacts" must be an array of strings/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: ['/etc/**'] })), /artifact glob "\/etc\/\*\*" must be a relative path inside the project/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: ['../x/**'] })), /must be a relative path inside the project/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: ['a/../../x'] })), /must be a relative path inside the project/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, artifacts: [''] })), /must be a relative path inside the project/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `timeouts` lacks `setup`, `c.setup` is `undefined`, no validation errors thrown.

- [ ] **Step 3: Implement** in `harness/lib/config.mjs`

Add `setup: '5m'` to `DEFAULTS.timeouts`:

```js
  timeouts: { install: '15m', claude: '45m', check: '10m', setup: '5m' },
```

Add after `stringArray`:

```js
// Globs are matched against project-relative paths, so they must stay inside the project.
function artifactGlobs(value) {
  const globs = stringArray(value, 'artifacts');
  for (const g of globs) {
    if (!g || g.startsWith('/') || g.split('/').includes('..')) {
      throw new Error(`artifact glob "${g}" must be a relative path inside the project`);
    }
  }
  return globs;
}
```

In `loadConfig`, before `const t = ...`:

```js
  if (raw.setup !== undefined && (typeof raw.setup !== 'string' || !raw.setup.trim())) {
    throw new Error('"setup" must be a non-empty command string');
  }
```

Replace the `timeouts` line with:

```js
  const timeouts = {
    install: parseDuration(t.install),
    claude: parseDuration(t.claude),
    check: parseDuration(t.check),
    setup: parseDuration(t.setup),
  };
```

and add to the returned object, after `install: raw.install,`:

```js
    setup: raw.setup ?? null,
```

and after `env: envMap(raw.env),`:

```js
    artifacts: artifactGlobs(raw.artifacts),
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 5: Commit**

```bash
git add harness/lib/config.mjs test/config.test.mjs
git commit -m "feat: optional setup command and artifact globs in agent.config.json"
```

---

## Task 2: Artifact collector

**Files:**
- Create: `harness/lib/artifacts.mjs`
- Test: `test/artifacts.test.mjs`

**Interfaces:**
- Consumes: `matchesAny(path, globs)` from `harness/lib/glob.mjs`.
- Produces: `collectArtifacts({ projectDir, globs, destDir, limits = ARTIFACT_LIMITS }) → { files, bytes, skipped }`; `ARTIFACT_LIMITS = { maxBytes: 52428800, maxFiles: 2000 }`. Empties `destDir` first; writes `destDir/TRUNCATED.txt` when `skipped > 0`. Never follows symlinks; skips `.git` and `node_modules` directories.

- [ ] **Step 1: Write the failing tests** — `test/artifacts.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectArtifacts } from '../harness/lib/artifacts.mjs';

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'artifacts-src-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
const dest = () => join(mkdtempSync(join(tmpdir(), 'artifacts-out-')), 'artifacts');

test('copies matching files with their relative paths', () => {
  const projectDir = tree({ 'report/index.html': '<h1>', 'report/data/a.png': 'png', 'src/app.js': 'x' });
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['report/**'], destDir });
  assert.deepEqual(r, { files: 2, bytes: 7, skipped: 0 });
  assert.equal(readFileSync(join(destDir, 'report/index.html'), 'utf8'), '<h1>');
  assert.equal(readFileSync(join(destDir, 'report/data/a.png'), 'utf8'), 'png');
  assert.equal(existsSync(join(destDir, 'src/app.js')), false);
});

test('never looks inside .git or node_modules', () => {
  const projectDir = tree({ '.git/report/x': '1', 'node_modules/report/y': '2', 'report/z': '3' });
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['**/report/**'], destDir });
  assert.equal(r.files, 1);
  assert.equal(existsSync(join(destDir, 'report/z')), true);
});

test('does not follow symlinks', () => {
  const outside = tree({ 'secret.txt': 'secret' });
  const projectDir = tree({ 'report/real.txt': 'ok' });
  symlinkSync(join(outside, 'secret.txt'), join(projectDir, 'report/link.txt'));
  symlinkSync(outside, join(projectDir, 'report/linkdir'));
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['report/**'], destDir });
  assert.equal(r.files, 1);
  assert.equal(existsSync(join(destDir, 'report/link.txt')), false);
  assert.equal(existsSync(join(destDir, 'report/linkdir')), false);
});

test('stops at the file cap and says so', () => {
  const projectDir = tree({ 'r/a': '1', 'r/b': '2', 'r/c': '3' });
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['r/**'], destDir, limits: { maxFiles: 2, maxBytes: 1000 } });
  assert.deepEqual(r, { files: 2, bytes: 2, skipped: 1 });
  assert.match(readFileSync(join(destDir, 'TRUNCATED.txt'), 'utf8'), /1 matching file\(s\) skipped/);
});

test('skips files that would exceed the byte cap but keeps smaller later ones', () => {
  const projectDir = tree({ 'r/a': '12345', 'r/b': '1234567890', 'r/c': '1' });
  const destDir = dest();
  const r = collectArtifacts({ projectDir, globs: ['r/**'], destDir, limits: { maxFiles: 10, maxBytes: 6 } });
  assert.deepEqual(r, { files: 2, bytes: 6, skipped: 1 });
  assert.equal(existsSync(join(destDir, 'r/b')), false);
  assert.equal(existsSync(join(destDir, 'TRUNCATED.txt')), true);
});

test('empties the destination first, so nothing planted there survives', () => {
  const projectDir = tree({ 'r/a': '1' });
  const destDir = dest();
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'planted.txt'), 'x');
  collectArtifacts({ projectDir, globs: ['r/**'], destDir });
  assert.equal(existsSync(join(destDir, 'planted.txt')), false);
  assert.equal(existsSync(join(destDir, 'r/a')), true);
});

test('no matches → empty result and no TRUNCATED.txt', () => {
  const projectDir = tree({ 'src/a': '1' });
  const destDir = dest();
  assert.deepEqual(collectArtifacts({ projectDir, globs: ['report/**'], destDir }), { files: 0, bytes: 0, skipped: 0 });
  assert.equal(existsSync(join(destDir, 'TRUNCATED.txt')), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/artifacts.test.mjs`
Expected: FAIL — `Cannot find module '../harness/lib/artifacts.mjs'`.

- [ ] **Step 3: Implement** — `harness/lib/artifacts.mjs`

```js
import { readdirSync, lstatSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { matchesAny } from './glob.mjs';

export const ARTIFACT_LIMITS = { maxBytes: 50 * 1024 * 1024, maxFiles: 2000 };
const SKIP_DIRS = new Set(['.git', 'node_modules']);

// Regular files only, in a stable order. Dirents come from lstat, so symlinks
// are neither files nor directories here and are never followed.
function* walk(root, dir = root) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(root, full);
    } else if (entry.isFile()) {
      yield relative(root, full).split(sep).join('/');
    }
  }
}

// Copies project files matching `globs` into destDir, keeping relative paths.
// destDir is emptied first: the agent can write under the run's output folder.
export function collectArtifacts({ projectDir, globs, destDir, limits = ARTIFACT_LIMITS }) {
  rmSync(destDir, { recursive: true, force: true });
  const result = { files: 0, bytes: 0, skipped: 0 };
  for (const rel of walk(projectDir)) {
    if (!matchesAny(rel, globs)) continue;
    const source = join(projectDir, rel);
    const size = lstatSync(source).size;
    if (result.files >= limits.maxFiles || result.bytes + size > limits.maxBytes) {
      result.skipped++;
      continue;
    }
    const target = join(destDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    result.files++;
    result.bytes += size;
  }
  if (result.skipped > 0) {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(
      join(destDir, 'TRUNCATED.txt'),
      `${result.skipped} matching file(s) skipped: limits are ${limits.maxFiles} files and ${limits.maxBytes} bytes.\n`,
    );
  }
  return result;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 5: Commit**

```bash
git add harness/lib/artifacts.mjs test/artifacts.test.mjs
git commit -m "feat: artifact collector with size caps and no symlink following"
```

---

## Task 3: Run setup before baseline and before verification; prompt rule

**Files:**
- Modify: `harness/run-task.mjs`, `harness/lib/agent.mjs`, `harness/prompt.md`
- Test: `test/pipeline.test.mjs`, `test/agent.test.mjs`

**Interfaces:**
- Consumes: `config.setup`, `config.timeouts.setup` (Task 1).
- Produces: `servicesRule(hasSetup: boolean) → string` exported from `harness/lib/agent.mjs`; prompt variable `SERVICES_RULE`; logs `logs/setup.log`, `logs/setup-verify.log`.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent.test.mjs` (add `servicesRule` to its existing import from `../harness/lib/agent.mjs`):

```js
test('servicesRule mentions running services only when the project has setup', () => {
  assert.match(servicesRule(true), /^Services started by the project's setup command are already running\. Do not start dev servers/);
  assert.match(servicesRule(false), /^Do not start dev servers or watchers yourself; a check command that starts and stops its own server/);
  assert.doesNotMatch(servicesRule(false), /setup command/);
});
```

Append to `test/pipeline.test.mjs`:

```js
function withConfig(change) {
  return (dir) => {
    const cfg = JSON.parse(readFileSync(join(dir, 'agent.config.json'), 'utf8'));
    change(cfg);
    writeFileSync(join(dir, 'agent.config.json'), JSON.stringify(cfg));
  };
}

test('setup runs before the baseline and again before verification', async () => {
  // build/ is git-ignored, so the post-agent clean deletes the marker: verification
  // only passes if setup recreated it.
  const { verdict, outDir } = await run({
    agent: 'honest.sh',
    mutate: withConfig((cfg) => {
      cfg.setup = 'mkdir -p build && echo up > build/services && echo ran';
      cfg.checks.test = 'test -f build/services && sh tests/run.sh';
    }),
  });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.match(readFileSync(join(outDir, 'logs', 'setup.log'), 'utf8'), /ran/);
  assert.match(readFileSync(join(outDir, 'logs', 'setup-verify.log'), 'utf8'), /ran/);
  assert.match(readFileSync(join(outDir, 'prompt.md'), 'utf8'), /Services started by the project's setup command are already running/);
});

test('a project without setup runs no setup step', async () => {
  const { verdict, outDir } = await run({ agent: 'honest.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.equal(existsSync(join(outDir, 'logs', 'setup.log')), false);
  assert.doesNotMatch(readFileSync(join(outDir, 'prompt.md'), 'utf8'), /setup command/);
});

test('failing setup → BLOCKED (harness) before the agent runs', async () => {
  const { verdict, projectDir } = await run({
    cmd: 'touch agent-ran',
    mutate: withConfig((cfg) => { cfg.setup = 'exit 3'; }),
  });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'harness');
  assert.deepEqual(verdict.reasons, ['setup failed (exit 3)']);
  assert.equal(existsSync(join(projectDir, 'agent-ran')), false);
});

test('setup timeout → BLOCKED (harness)', async () => {
  const { verdict } = await run({
    cmd: 'touch agent-ran',
    mutate: withConfig((cfg) => { cfg.setup = 'sleep 5'; cfg.timeouts.setup = '1s'; }),
  });
  assert.deepEqual(verdict.reasons, ['setup timed out']);
});

test('setup failing before verification → BLOCKED (harness), commits kept', async () => {
  const mark = join(mkdtempSync(join(tmpdir(), 'harness-mark-')), 'once');
  const { verdict } = await run({
    agent: 'honest.sh',
    mutate: withConfig((cfg) => {
      cfg.env = { SETUP_MARK: mark };
      cfg.setup = 'if [ -f "$SETUP_MARK" ]; then exit 4; fi; touch "$SETUP_MARK"';
    }),
  });
  assert.equal(verdict.kind, 'harness');
  assert.deepEqual(verdict.reasons, ['setup before verification failed (exit 4)']);
  assert.equal(verdict.commits, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `servicesRule` is not exported; no `setup.log`; setup failures not reported.

- [ ] **Step 3: Add `servicesRule`** to `harness/lib/agent.mjs`, after `renderPrompt`:

```js
const NO_DEV_SERVERS =
  "Do not start dev servers or watchers yourself; a check command that starts and stops its own server (for example a test runner's web-server option) is fine.";

// The prompt's process rule; projects with a setup command also learn their services are up.
export function servicesRule(hasSetup) {
  return hasSetup ? `Services started by the project's setup command are already running. ${NO_DEV_SERVERS}` : NO_DEV_SERVERS;
}
```

- [ ] **Step 4: Use it in `harness/prompt.md`** — replace the line

```
- Never start dev servers, watchers, or any process that does not exit on its own.
```

with

```
- {{SERVICES_RULE}}
```

- [ ] **Step 5: Wire setup into `harness/run-task.mjs`**

Add `servicesRule` to the import from `./lib/agent.mjs`.

After the `installFailed` helper, add:

```js
  // Setup starts the services checks need (databases, browsers). It must be
  // idempotent: it runs again before verification in case the agent broke them.
  const setup = async (logName, label) => {
    if (!config.setup) return null;
    const r = await runWithTimeout(config.setup, {
      cwd: projectDir, timeoutSec: config.timeouts.setup, logFile: join(logsDir, logName), env: quietEnv,
    });
    if (r.timedOut) return `${label} timed out`;
    return r.exitCode === 0 ? null : `${label} failed (exit ${r.exitCode})`;
  };
```

After the `firstInstall` failure check, before `const baseline = ...`:

```js
  const setupError = await setup('setup.log', 'setup');
  if (setupError) return finish(blocked('harness', setupError));
```

In the `renderPrompt` variables, add:

```js
    SERVICES_RULE: servicesRule(Boolean(config.setup)),
```

In the verification branch, after the `reinstall` failure check and before `checks = await runChecks(...)`:

```js
    const verifySetupError = await setup('setup-verify.log', 'setup before verification');
    if (verifySetupError) return finish({ ...blocked('harness', verifySetupError), commits, diff, baseSha });
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 7: Commit**

```bash
git add harness/run-task.mjs harness/lib/agent.mjs harness/prompt.md test/pipeline.test.mjs test/agent.test.mjs
git commit -m "feat: run the project's setup command before baseline and verification"
```

---

## Task 4: Collect artifacts in the run and mention them in comments and PRs

**Files:**
- Modify: `harness/run-task.mjs`, `harness/lib/format.mjs`
- Test: `test/pipeline.test.mjs`, `test/format.test.mjs`

**Interfaces:**
- Consumes: `collectArtifacts` (Task 2), `config.artifacts` (Task 1).
- Produces: verdict field `artifacts: { files, bytes, skipped } | null` (null when nothing was attempted or collection failed); `<out>/artifacts/…`; `logs/artifacts.log` on collection errors.

- [ ] **Step 1: Write the failing tests**

Append to `test/pipeline.test.mjs`:

```js
test('artifacts from the verification checks are collected', async () => {
  const { verdict, outDir } = await run({
    agent: 'honest.sh',
    mutate: withConfig((cfg) => {
      cfg.artifacts = ['build/report/**'];
      cfg.checks.test = 'mkdir -p build/report && echo "$(date)" > build/report/out.txt && sh tests/run.sh';
    }),
  });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.equal(verdict.artifacts.files, 1);
  assert.equal(existsSync(join(outDir, 'artifacts', 'build', 'report', 'out.txt')), true);
});

test('files the agent leaves for collection are not uploaded', async () => {
  const { verdict, outDir } = await run({
    cmd: `mkdir -p build/report "$(dirname "$REPORT_PATH")/artifacts" && echo planted > build/report/planted.txt && echo planted > "$(dirname "$REPORT_PATH")/artifacts/planted.txt" && sh "${join(AGENTS, 'honest.sh')}"`,
    mutate: withConfig((cfg) => { cfg.artifacts = ['build/report/**']; }),
  });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.deepEqual(verdict.artifacts, { files: 0, bytes: 0, skipped: 0 });
  assert.equal(existsSync(join(outDir, 'artifacts', 'build', 'report', 'planted.txt')), false);
  assert.equal(existsSync(join(outDir, 'artifacts', 'planted.txt')), false);
});

test('a red base still collects artifacts', async () => {
  const { verdict, outDir } = await run({
    cmd: 'touch agent-ran',
    mutate: (dir, git) => {
      withConfig((cfg) => {
        cfg.artifacts = ['build/report/**'];
        cfg.checks.test = 'mkdir -p build/report && echo red > build/report/out.txt && sh tests/run.sh';
      })(dir, git);
      writeFileSync(join(dir, 'value.txt'), '2\n');
    },
  });
  assert.equal(verdict.kind, 'gate');
  assert.equal(verdict.artifacts.files, 1);
  assert.equal(readFileSync(join(outDir, 'artifacts', 'build', 'report', 'out.txt'), 'utf8').trim(), 'red');
});

test('without artifact globs nothing is collected', async () => {
  const { verdict, outDir } = await run({ agent: 'honest.sh' });
  assert.equal(verdict.artifacts, null);
  assert.equal(existsSync(join(outDir, 'artifacts')), false);
});
```

Append to `test/format.test.mjs`:

```js
test('collected artifacts are mentioned in the comment and the PR body', () => {
  const v = { ...readyVerdict, artifacts: { files: 3, bytes: 100, skipped: 0 } };
  assert.match(renderComment(v, { runUrl: 'https://run', prUrl: 'https://pr' }), /\[Run log and artifacts\]\(https:\/\/run\) · artifacts collected \(3 files\)/);
  assert.match(renderPrBody(v), /Artifacts: 3 files collected in the run artifact\./);
  const blockedV = { ...v, outcome: 'BLOCKED', kind: 'gate', reasons: ['x'], report: null, commits: 0 };
  assert.match(renderComment(blockedV, { runUrl: 'https://run' }), /artifacts collected \(3 files\)/);
});

test('no artifacts → no artifacts line', () => {
  assert.doesNotMatch(renderComment(readyVerdict, { runUrl: 'https://run', prUrl: 'https://pr' }), /artifacts collected/);
  assert.doesNotMatch(renderPrBody({ ...readyVerdict, artifacts: { files: 0, bytes: 0, skipped: 0 } }), /Artifacts:/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `verdict.artifacts` undefined; no artifacts line.

- [ ] **Step 3: Collect in `harness/run-task.mjs`**

Add imports: `appendFileSync` to the `node:fs` import, and

```js
import { collectArtifacts } from './lib/artifacts.mjs';
```

Add `artifacts: null` to the `meta` object (after `reportText: null`).

After the `setup` helper (Task 3), add:

```js
  // Evidence from the harness's own check run (test reports, screenshots).
  // Collection problems are logged and never change the verdict.
  const collect = () => {
    if (!config.artifacts.length) return null;
    try {
      return collectArtifacts({ projectDir, globs: config.artifacts, destDir: join(outDir, 'artifacts') });
    } catch (e) {
      appendFileSync(join(logsDir, 'artifacts.log'), `${e.stack ?? e}\n`);
      return null;
    }
  };
```

Change the red-base return to:

```js
    return finish({ ...blocked('gate', `base is red: ${red.join(', ')} failed before the agent started`), checks: baseline, artifacts: collect() });
```

In the verification branch, right after `checks = await runChecks(config, projectDir, logsDir, 'verify', quietEnv);`:

```js
    meta.artifacts = collect();
```

- [ ] **Step 4: Mention them in `harness/lib/format.mjs`**

Add after `bullets`:

```js
const runLink = (v, runUrl) =>
  `[Run log and artifacts](${runUrl})${v.artifacts?.files ? ` · artifacts collected (${v.artifacts.files} files)` : ''}`;
```

Replace each of the three `` `[Run log and artifacts](${runUrl})` `` occurrences in `renderComment` with `runLink(v, runUrl)` (the READY line becomes `` `✅ **READY_FOR_QA** — ${prUrl ?? 'PR opened'}\n\n${runLink(v, runUrl)}` ``).

In `renderPrBody`, after `checkTable(v.checks),` add:

```js
    ...(v.artifacts?.files ? ['', `Artifacts: ${v.artifacts.files} files collected in the run artifact.`] : []),
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 6: Commit**

```bash
git add harness/run-task.mjs harness/lib/format.mjs test/pipeline.test.mjs test/format.test.mjs
git commit -m "feat: collect project artifacts after the authoritative check run"
```

---

## Task 5: Documentation

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-02-agent-harness-design.md` (§5, §6)

- [ ] **Step 1: README** — add before `## Usage limits and a second account`:

````markdown
## Services and artifacts

Checks that need running services (a database, a browser) get them from an optional `setup` command, run after install, before the baseline checks, and again before the harness's own verification — so it must be safe to run twice. A failing or timed-out setup blocks the run as a harness problem. Default timeout `timeouts.setup`: `5m`.

`artifacts` lists globs (relative to the project root) whose files are copied into the run artifact after the harness's verification checks (or after a red baseline): test reports, screenshots, traces. Caps: 50 MB and 2,000 files. Symlinks, `.git` and `node_modules` are skipped. Artifacts of public repositories are downloadable by any signed-in GitHub user, so never collect anything secret.

```json
{
  "install": "pnpm install --frozen-lockfile",
  "setup": "docker compose -f docker-compose.test.yml up -d --wait && pnpm db:push:test",
  "checks": { "test": "pnpm test", "e2e": "pnpm exec playwright test" },
  "artifacts": ["playwright-report/**", "test-results/**"]
}
```
````

- [ ] **Step 2: Design spec** — in §5, after the sentence `Only \`install\` and \`checks\` are required; ...`, add:

```markdown
Optional `setup` (command) and `artifacts` (globs), plus `timeouts.setup`, are specified in `2026-10-02-setup-and-artifacts-design.md`.
```

In §6 step 5 (`**Prepare.**`), append: ` Then run \`setup\` if configured (again before step 8).` In step 11 (`**Artifacts.**`), append: ` Plus files matching the project's \`artifacts\` globs.`

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-10-02-agent-harness-design.md
git commit -m "docs: setup hook and artifacts"
```

---

## Task 6: Release (interactive — needs the user's go-ahead for the tag)

- [ ] **Step 1: Lint the workflows** — `actionlint` (workflows are unchanged; this guards against accidental edits).
- [ ] **Step 2: Merge to `main`** via PR from `feat/setup-and-artifacts`.
- [ ] **Step 3: Sandbox run** — in `agent-harness-sandbox` (uses `@main`), set `"setup": "mkdir -p build && echo up > build/services"`, `"artifacts": ["build/**"]`, a check that requires `build/services`; run one task; confirm `READY_FOR_QA`, `logs/setup.log` + `logs/setup-verify.log` and `artifacts/build/services` in the run artifact, and the "artifacts collected" line in the comment.
- [ ] **Step 4: Move `v1`** — `git tag -f v1 main && git push -f origin v1` (only after the user confirms).
