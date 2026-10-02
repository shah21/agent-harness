# Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable GitHub Actions harness that executes one plan task per run with Claude Code, re-verifies the result deterministically, and publishes a PR (`READY_FOR_QA`) or an issue comment (`BLOCKED`).

**Architecture:** All judgement logic lives in small zero-dependency Node ES modules under `harness/lib/`, unit-tested with `node:test`. `harness/run-task.mjs` orchestrates the local, network-free part of a run (config → install → baseline → agent → verify → gate) and is tested end-to-end with scripted fake agents against a fixture project. GitHub interaction (select, claim, publish, re-dispatch) lives in a reusable workflow plus `harness/publish.sh`, verified on a real sandbox repo.

**Tech Stack:** Node.js ≥ 22 (ES modules, `node:test`, `node:child_process`), POSIX `sh`, bash + `gh` + `jq` (GitHub-hosted runners), GitHub Actions reusable workflows, Claude Code CLI (`@anthropic-ai/claude-code`).

**Spec:** `docs/superpowers/specs/2026-10-02-agent-harness-design.md`

## Global Constraints

- Node ≥ 22; ES modules (`.mjs`); **zero npm dependencies** (runtime or dev).
- Tests: `node --test` only. Run all with `npm test`.
- Project config file name: `agent.config.json` (JSON, not YAML).
- Defaults, verbatim from spec: `model: "sonnet"`, `maxTurns: 150`, timeouts `install: "15m"`, `claude: "45m"`, `check: "10m"`; `testGlobs: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "e2e/**"]`.
- `.github/**` and `agent.config.json` are always protected.
- Job timeout: 90 minutes. Concurrency group: `agent-<repo>`, `cancel-in-progress: false`.
- Labels: `agent`, `agent:opus`, `agent:running`, `agent:ready`, `agent:blocked`.
- Branch name: `agent/issue-<n>`. Report path: `$RUNNER_TEMP/agent/report.md` (outside the checkout).
- Allowed agent tools: `Read,Edit,Write,Glob,Grep,Bash`.
- Claude's environment never contains a GitHub token; checkouts use `persist-credentials: false`.
- Never auto-merge, never deploy.

## Review Focus

1. **Agent leaves uncommitted changes that only pass in the working tree** → harness stashes them and verifies the committed state; the run is blocked if commits alone fail (Task 10, `dirty.sh` scenario).
2. **Report wrapped in markdown code fences or written with CRLF line endings** → still parsed (Task 4).
3. **Agent or a check spawns background processes** (a server started with `&`) → the whole process group is killed on timeout *and* after normal exit (Task 8).
4. **Issue body with CRLF, extra prose, or a path like `../x.md` / `/etc/x`** → parsed correctly or rejected as a bad reference (Task 3).
5. **Several issues labeled at once, including a re-queued previously-blocked task** → deterministic order (plan, then task number); a re-queued task is never its own "upstream blocked" (Task 6).

---

### Task 1: Repository skeleton, glob matcher, CI

**Files:**
- Create: `package.json`, `.gitignore`, `.github/workflows/ci.yml`
- Create: `harness/lib/glob.mjs`
- Test: `test/glob.test.mjs`

**Interfaces:**
- Produces: `globToRegExp(glob: string): RegExp`, `matchesAny(path: string, globs: string[]): boolean`

- [ ] **Step 1: Create the skeleton**

`package.json`:
```json
{
  "name": "agent-harness",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": { "test": "node --test test/*.test.mjs" }
}
```

`.gitignore`:
```
node_modules/
.DS_Store
```

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm test
```

- [ ] **Step 2: Write the failing test** — `test/glob.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAny } from '../harness/lib/glob.mjs';

test('**/ matches any depth, including the root', () => {
  assert.ok(matchesAny('a.test.ts', ['**/*.test.ts']));
  assert.ok(matchesAny('src/lib/a.test.ts', ['**/*.test.ts']));
  assert.ok(!matchesAny('src/lib/a.test.tsx', ['**/*.test.ts']));
});

test('dir/** matches everything under dir only', () => {
  assert.ok(matchesAny('.github/workflows/ci.yml', ['.github/**']));
  assert.ok(!matchesAny('src/.github.ts', ['.github/**']));
});

test('single * does not cross directories', () => {
  assert.ok(matchesAny('src/a.ts', ['src/*.ts']));
  assert.ok(!matchesAny('src/x/a.ts', ['src/*.ts']));
});

test('dots are literal', () => {
  assert.ok(matchesAny('agent.config.json', ['agent.config.json']));
  assert.ok(!matchesAny('agentXconfigXjson', ['agent.config.json']));
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../harness/lib/glob.mjs`

- [ ] **Step 4: Implement** — `harness/lib/glob.mjs`

```js
// Minimal glob → RegExp: supports **, *, ? and literal characters.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}
```

- [ ] **Step 5: Run tests** — `npm test` → all PASS

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore .github/workflows/ci.yml harness/lib/glob.mjs test/glob.test.mjs
git commit -m "feat: repo skeleton and glob matcher"
```

---

### Task 2: Project config loader

**Files:**
- Create: `harness/lib/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `parseDuration(value: string): number` (seconds); `loadConfig(text: string): Config` where `Config = { install: string, checks: Record<string,string>, model: string, maxTurns: number, timeouts: { install: number, claude: number, check: number } /* seconds */, protectedPaths: string[], testGlobs: string[] }`. Throws `Error` with a human-readable message on invalid input.

- [ ] **Step 1: Write the failing test** — `test/config.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseDuration } from '../harness/lib/config.mjs';

const minimal = JSON.stringify({ install: 'pnpm install', checks: { test: 'pnpm test' } });

test('applies defaults', () => {
  const c = loadConfig(minimal);
  assert.equal(c.install, 'pnpm install');
  assert.deepEqual(c.checks, { test: 'pnpm test' });
  assert.equal(c.model, 'sonnet');
  assert.equal(c.maxTurns, 150);
  assert.deepEqual(c.timeouts, { install: 900, claude: 2700, check: 600 });
  assert.deepEqual(c.protectedPaths, ['.github/**', 'agent.config.json']);
  assert.deepEqual(c.testGlobs, ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'e2e/**']);
});

test('always protects .github and the config file', () => {
  const c = loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, protectedPaths: ['infra/**'] }));
  assert.deepEqual(c.protectedPaths, ['.github/**', 'agent.config.json', 'infra/**']);
});

test('partial timeouts merge with defaults', () => {
  const c = loadConfig(JSON.stringify({ install: 'x', checks: { t: 'y' }, timeouts: { claude: '20m' } }));
  assert.deepEqual(c.timeouts, { install: 900, claude: 1200, check: 600 });
});

test('parseDuration', () => {
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('1h'), 3600);
  assert.throws(() => parseDuration('10'), /invalid duration/);
  assert.throws(() => parseDuration('0m'), /invalid duration/);
  assert.throws(() => parseDuration('abc'), /invalid duration/);
});

test('rejects bad configs with a readable message', () => {
  assert.throws(() => loadConfig('{'), /not valid JSON/);
  assert.throws(() => loadConfig('[]'), /JSON object/);
  assert.throws(() => loadConfig(JSON.stringify({ checks: { t: 'x' } })), /"install"/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: {} })), /"checks"/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: { 'Bad Name': 'x' } })), /check name/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: { t: '' } })), /check "t"/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: { t: 'x' }, maxTurns: 0 })), /maxTurns/);
  assert.throws(() => loadConfig(JSON.stringify({ install: 'x', checks: { t: 'x' }, testGlobs: 'x' })), /testGlobs/);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL (module not found)

- [ ] **Step 3: Implement** — `harness/lib/config.mjs`

```js
const ALWAYS_PROTECTED = ['.github/**', 'agent.config.json'];
const DEFAULTS = {
  model: 'sonnet',
  maxTurns: 150,
  timeouts: { install: '15m', claude: '45m', check: '10m' },
  testGlobs: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'e2e/**'],
};

export function parseDuration(value) {
  const m = /^(\d+)(s|m|h)$/.exec(String(value));
  if (!m || Number(m[1]) === 0) throw new Error(`invalid duration "${value}" (use e.g. 30s, 10m, 1h)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}

function stringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    throw new Error(`"${field}" must be an array of strings`);
  }
  return value;
}

export function loadConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('must be a JSON object');
  if (typeof raw.install !== 'string' || !raw.install.trim()) throw new Error('"install" must be a non-empty string');

  const checks = raw.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks) || Object.keys(checks).length === 0) {
    throw new Error('"checks" must be an object with at least one check');
  }
  for (const [name, cmd] of Object.entries(checks)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`check name "${name}" must be lowercase letters, digits, - or _`);
    if (typeof cmd !== 'string' || !cmd.trim()) throw new Error(`check "${name}" must be a non-empty command string`);
  }

  const model = raw.model ?? DEFAULTS.model;
  if (typeof model !== 'string' || !model) throw new Error('"model" must be a non-empty string');
  const maxTurns = raw.maxTurns ?? DEFAULTS.maxTurns;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('"maxTurns" must be a positive integer');

  const t = { ...DEFAULTS.timeouts, ...(raw.timeouts ?? {}) };
  const timeouts = { install: parseDuration(t.install), claude: parseDuration(t.claude), check: parseDuration(t.check) };

  return {
    install: raw.install,
    checks: { ...checks },
    model,
    maxTurns,
    timeouts,
    protectedPaths: [...new Set([...ALWAYS_PROTECTED, ...stringArray(raw.protectedPaths, 'protectedPaths')])],
    testGlobs: raw.testGlobs === undefined ? DEFAULTS.testGlobs : stringArray(raw.testGlobs, 'testGlobs'),
  };
}
```

- [ ] **Step 4: Run tests** — `npm test` → all PASS

- [ ] **Step 5: Commit**

```bash
git add harness/lib/config.mjs test/config.test.mjs
git commit -m "feat: agent.config.json loader with defaults"
```

---

### Task 3: Issue task-reference parsing

**Files:**
- Create: `harness/lib/issue.mjs`
- Test: `test/issue.test.mjs`

**Interfaces:**
- Produces: `parseTaskRef(body: string): { plan: string, task: number } | { error: string }`; `findTaskHeading(planText: string, task: number): string | null` (returns the heading title).

- [ ] **Step 1: Write the failing test** — `test/issue.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskRef, findTaskHeading } from '../harness/lib/issue.mjs';

test('parses plan and task lines', () => {
  assert.deepEqual(parseTaskRef('plan: docs/p.md\ntask: 3\n'), { plan: 'docs/p.md', task: 3 });
});

test('tolerates CRLF and surrounding prose', () => {
  assert.deepEqual(
    parseTaskRef('Please run this.\r\n\r\nplan: docs/p.md\r\ntask: 12\r\nThanks'),
    { plan: 'docs/p.md', task: 12 },
  );
});

test('reports missing lines', () => {
  assert.match(parseTaskRef('task: 1').error, /plan:/);
  assert.match(parseTaskRef('plan: docs/p.md').error, /task:/);
  assert.match(parseTaskRef(null).error, /plan:/);
});

test('rejects paths that escape the repository', () => {
  assert.match(parseTaskRef('plan: ../x.md\ntask: 1').error, /relative inside the repo/);
  assert.match(parseTaskRef('plan: docs/../../x.md\ntask: 1').error, /relative inside the repo/);
  assert.match(parseTaskRef('plan: /etc/x.md\ntask: 1').error, /relative inside the repo/);
});

test('findTaskHeading matches the exact task number at ## or ###', () => {
  const plan = '# Plan\n## Task 1: First\n## Task 10: Tenth\n### Task 2: Second\n';
  assert.equal(findTaskHeading(plan, 1), 'First');
  assert.equal(findTaskHeading(plan, 10), 'Tenth');
  assert.equal(findTaskHeading(plan, 2), 'Second');
  assert.equal(findTaskHeading(plan, 3), null);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL (module not found)

- [ ] **Step 3: Implement** — `harness/lib/issue.mjs`

```js
export function parseTaskRef(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const plan = /^plan:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
  const task = /^task:[ \t]*(\d+)[ \t]*$/m.exec(text)?.[1];
  if (!plan) return { error: 'issue body has no "plan: <path>" line' };
  if (!task) return { error: 'issue body has no "task: <number>" line' };
  if (plan.startsWith('/') || plan.split('/').includes('..')) {
    return { error: `plan path must be relative inside the repo: ${plan}` };
  }
  return { plan, task: Number(task) };
}

export function findTaskHeading(planText, task) {
  const text = String(planText).replace(/\r\n/g, '\n');
  const m = new RegExp(`^#{2,3} Task ${task}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text);
  return m ? m[1] : null;
}
```

- [ ] **Step 4: Run tests** — `npm test` → all PASS

- [ ] **Step 5: Commit**

```bash
git add harness/lib/issue.mjs test/issue.test.mjs
git commit -m "feat: parse plan/task references from issue bodies"
```

---

### Task 4: Report parser

**Files:**
- Create: `harness/lib/report.mjs`
- Test: `test/report.test.mjs`

**Interfaces:**
- Produces: `parseReport(text: string): { ok: true, report: Report } | { ok: false, errors: string[] }` where `Report = { status: 'READY_FOR_QA'|'BLOCKED', task, summary, changedFiles: string[], checks: Record<string,'PASS'|'FAIL'|'NOT_RUN'>, selfReview, knownIssues, blocker, evidence, requiredHumanAction }` (all text fields are strings, `''` when absent).

- [ ] **Step 1: Write the failing test** — `test/report.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../harness/lib/report.mjs';

const READY = [
  'STATUS: READY_FOR_QA',
  'TASK: plan=docs/p.md task=1 issue=#7',
  'SUMMARY:',
  'Added greeting.',
  'CHANGED_FILES:',
  '- greeting.txt',
  '- `tests/greeting.test.sh`',
  'CHECKS:',
  '- test: PASS',
  '- lint: FAIL',
  'SELF_REVIEW:',
  'Scoped.',
  'KNOWN_ISSUES:',
  'None',
].join('\n');

const BLOCKED = [
  'STATUS: BLOCKED',
  'TASK: plan=docs/p.md task=1 issue=#7',
  'BLOCKER:',
  'No secret.',
  'EVIDENCE:',
  '$ echo $KEY',
  '(empty)',
  'REQUIRED_HUMAN_ACTION:',
  'Set KEY.',
].join('\n');

test('parses a ready report', () => {
  const r = parseReport(READY);
  assert.equal(r.ok, true);
  assert.equal(r.report.status, 'READY_FOR_QA');
  assert.equal(r.report.summary, 'Added greeting.');
  assert.deepEqual(r.report.changedFiles, ['greeting.txt', 'tests/greeting.test.sh']);
  assert.deepEqual(r.report.checks, { test: 'PASS', lint: 'FAIL' });
  assert.equal(r.report.knownIssues, 'None');
});

test('tolerates code fences and CRLF', () => {
  const r = parseReport('```\r\n' + READY.replace(/\n/g, '\r\n') + '\r\n```\r\n');
  assert.equal(r.ok, true);
  assert.equal(r.report.knownIssues, 'None');
});

test('parses a complete blocked report', () => {
  const r = parseReport(BLOCKED);
  assert.equal(r.ok, true);
  assert.equal(r.report.blocker, 'No secret.');
  assert.equal(r.report.evidence, '$ echo $KEY\n(empty)');
  assert.equal(r.report.requiredHumanAction, 'Set KEY.');
});

test('blocked report requires blocker fields', () => {
  const r = parseReport('STATUS: BLOCKED\nTASK: t\nBLOCKER:\nNo secret.\n');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['missing EVIDENCE', 'missing REQUIRED_HUMAN_ACTION']);
});

test('ready report requires its fields', () => {
  const r = parseReport('STATUS: READY_FOR_QA\nTASK: t\n');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['missing SUMMARY', 'missing CHANGED_FILES', 'missing CHECKS', 'missing SELF_REVIEW', 'missing KNOWN_ISSUES']);
});

test('rejects missing or unknown status', () => {
  assert.deepEqual(parseReport('hello').errors, ['missing STATUS', 'missing TASK']);
  assert.match(parseReport('STATUS: DONE\nTASK: t').errors[0], /STATUS must be READY_FOR_QA or BLOCKED/);
});

test('rejects unreadable CHECKS lines', () => {
  const r = parseReport(READY.replace('- lint: FAIL', '- lint: probably fine'));
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /unreadable CHECKS line/);
});

test('a repeated key inside a field is content, not a new field', () => {
  const r = parseReport(READY.replace('KNOWN_ISSUES:\nNone', 'KNOWN_ISSUES:\nSTATUS: flaky upstream'));
  assert.equal(r.ok, true);
  assert.equal(r.report.status, 'READY_FOR_QA');
  assert.equal(r.report.knownIssues, 'STATUS: flaky upstream');
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL (module not found)

- [ ] **Step 3: Implement** — `harness/lib/report.mjs`

```js
const KEYS = ['STATUS', 'TASK', 'SUMMARY', 'CHANGED_FILES', 'CHECKS', 'SELF_REVIEW', 'KNOWN_ISSUES', 'BLOCKER', 'EVIDENCE', 'REQUIRED_HUMAN_ACTION'];
const REQUIRED = {
  READY_FOR_QA: ['SUMMARY', 'CHANGED_FILES', 'CHECKS', 'SELF_REVIEW', 'KNOWN_ISSUES'],
  BLOCKED: ['BLOCKER', 'EVIDENCE', 'REQUIRED_HUMAN_ACTION'],
};
const KEY_RE = new RegExp(`^(${KEYS.join('|')}):[ \\t]*(.*)$`);

export function parseReport(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*```/.test(l));

  const fields = {};
  let current = null;
  for (const line of lines) {
    const m = KEY_RE.exec(line);
    if (m && !(m[1] in fields)) {
      current = m[1];
      fields[current] = m[2] ? [m[2]] : [];
    } else if (current) {
      fields[current].push(line);
    }
  }

  const value = (k) => (fields[k] ?? []).join('\n').trim();
  const listItems = (k) =>
    (fields[k] ?? [])
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim().replace(/^`(.*)`$/, '$1'));

  const errors = [];
  const status = value('STATUS');
  if (!('STATUS' in fields)) errors.push('missing STATUS');
  else if (!(status in REQUIRED)) errors.push(`STATUS must be READY_FOR_QA or BLOCKED, got "${status}"`);
  if (!value('TASK')) errors.push('missing TASK');
  for (const k of REQUIRED[status] ?? []) if (!value(k)) errors.push(`missing ${k}`);
  if (errors.length) return { ok: false, errors };

  const checks = {};
  for (const item of listItems('CHECKS')) {
    const m = /^([a-z][a-z0-9_-]*):\s*(PASS|FAIL|NOT_RUN)$/.exec(item);
    if (!m) return { ok: false, errors: [`unreadable CHECKS line: "- ${item}"`] };
    checks[m[1]] = m[2];
  }

  return {
    ok: true,
    report: {
      status,
      task: value('TASK'),
      summary: value('SUMMARY'),
      changedFiles: listItems('CHANGED_FILES'),
      checks,
      selfReview: value('SELF_REVIEW'),
      knownIssues: value('KNOWN_ISSUES'),
      blocker: value('BLOCKER'),
      evidence: value('EVIDENCE'),
      requiredHumanAction: value('REQUIRED_HUMAN_ACTION'),
    },
  };
}
```

- [ ] **Step 4: Run tests** — `npm test` → all PASS

- [ ] **Step 5: Commit**

```bash
git add harness/lib/report.mjs test/report.test.mjs
git commit -m "feat: agent report parser"
```

---

### Task 5: Gate decision table

**Files:**
- Create: `harness/lib/gate.mjs`
- Test: `test/gate.test.mjs`

**Interfaces:**
- Consumes: `parseReport` (Task 4), `matchesAny` (Task 1).
- Produces: `decide(input): Decision` where
  `input = { agent: { exitCode: number, timedOut: boolean }, reportText: string|null, commits: number, diff: Array<{ status: 'A'|'M'|'D'|'R'|'C'|'T', path: string, oldPath?: string }>, checks: Record<string, { ok: boolean }>, config: { protectedPaths: string[], testGlobs: string[] } }`
  `Decision = { outcome: 'READY_FOR_QA'|'BLOCKED', kind: 'agent'|'harness'|'report'|'gate'|null, reasons: string[], warnings: string[], report?: Report }`

- [ ] **Step 1: Write the failing test** — `test/gate.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../harness/lib/gate.mjs';

const config = { protectedPaths: ['.github/**', 'agent.config.json'], testGlobs: ['tests/**'] };
const ready = ({ checks = '- test: PASS\n- lint: PASS', files = '- a.txt' } = {}) =>
  `STATUS: READY_FOR_QA\nTASK: t\nSUMMARY:\ns\nCHANGED_FILES:\n${files}\nCHECKS:\n${checks}\nSELF_REVIEW:\nok\nKNOWN_ISSUES:\nNone\n`;
const allOk = { test: { ok: true }, lint: { ok: true } };
const base = {
  agent: { exitCode: 0, timedOut: false },
  reportText: ready(),
  commits: 1,
  diff: [{ status: 'A', path: 'a.txt' }],
  checks: allOk,
  config,
};
const run = (over) => decide({ ...base, ...over });

test('1: agent timeout wins over everything else', () => {
  const d = run({ agent: { exitCode: 137, timedOut: true }, reportText: null });
  assert.equal(d.outcome, 'BLOCKED');
  assert.equal(d.kind, 'agent');
  assert.match(d.reasons[0], /timed out/);
});

test('1: agent non-zero exit', () => {
  const d = run({ agent: { exitCode: 1, timedOut: false } });
  assert.equal(d.kind, 'agent');
  assert.match(d.reasons[0], /exited with code 1/);
});

test('2: missing or malformed report', () => {
  assert.deepEqual(run({ reportText: null }).reasons, ['agent wrote no report']);
  assert.equal(run({ reportText: null }).kind, 'harness');
  const d = run({ reportText: 'hello' });
  assert.equal(d.kind, 'harness');
  assert.deepEqual(d.reasons, ['report: missing STATUS', 'report: missing TASK']);
});

test('3: agent reports BLOCKED', () => {
  const d = run({
    reportText: 'STATUS: BLOCKED\nTASK: t\nBLOCKER:\nNo secret.\nEVIDENCE:\nx\nREQUIRED_HUMAN_ACTION:\nSet it.',
    commits: 0,
  });
  assert.equal(d.outcome, 'BLOCKED');
  assert.equal(d.kind, 'report');
  assert.deepEqual(d.reasons, ['No secret.']);
  assert.equal(d.report.requiredHumanAction, 'Set it.');
});

test('4: ready with no commits', () => {
  const d = run({ commits: 0 });
  assert.equal(d.kind, 'gate');
  assert.match(d.reasons[0], /no commits/);
});

test('5: protected paths, including rename sources', () => {
  assert.match(run({ diff: [{ status: 'A', path: '.github/x.yml' }] }).reasons[0], /protected paths: \.github\/x\.yml/);
  const d = run({ diff: [{ status: 'R', oldPath: 'agent.config.json', path: 'x.json' }] });
  assert.match(d.reasons[0], /protected paths: agent\.config\.json/);
});

test('6: deleted or renamed existing tests', () => {
  assert.match(run({ diff: [{ status: 'D', path: 'tests/a.sh' }] }).reasons[0], /existing tests deleted or renamed: tests\/a\.sh/);
  assert.match(run({ diff: [{ status: 'R', oldPath: 'tests/b.sh', path: 'old/b.sh' }] }).reasons[0], /tests\/b\.sh/);
  assert.equal(run({ diff: [{ status: 'M', path: 'tests/a.sh' }], reportText: ready({ files: '- tests/a.sh' }) }).outcome, 'READY_FOR_QA');
});

test('7: real check failures, flagging false PASS claims', () => {
  const d = run({ checks: { test: { ok: false }, lint: { ok: true } } });
  assert.equal(d.kind, 'gate');
  assert.deepEqual(d.reasons, ['check "test" failed (report claimed PASS)']);
  const honest = run({ checks: { test: { ok: false }, lint: { ok: true } }, reportText: ready({ checks: '- test: FAIL\n- lint: PASS' }) });
  assert.deepEqual(honest.reasons, ['check "test" failed']);
});

test('8: ready with no warnings', () => {
  const d = run({});
  assert.equal(d.outcome, 'READY_FOR_QA');
  assert.equal(d.kind, null);
  assert.deepEqual(d.reasons, []);
  assert.deepEqual(d.warnings, []);
});

test('warnings: check status mismatch, changed files mismatch, dependency files', () => {
  assert.deepEqual(run({ reportText: ready({ checks: '- test: PASS\n- lint: NOT_RUN' }) }).warnings, [
    'report listed check "lint" as NOT_RUN, but it passed when the harness ran it',
  ]);
  assert.deepEqual(run({ reportText: ready({ files: '- b.txt' }) }).warnings, [
    'CHANGED_FILES does not match the diff (diff: a.txt)',
  ]);
  const deps = run({ diff: [{ status: 'M', path: 'package.json' }], reportText: ready({ files: '- package.json' }) });
  assert.deepEqual(deps.warnings, ['dependency files changed: package.json']);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL (module not found)

- [ ] **Step 3: Implement** — `harness/lib/gate.mjs`

```js
import { parseReport } from './report.mjs';
import { matchesAny } from './glob.mjs';

const MANIFESTS = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

function blocked(kind, reasons, extra = {}) {
  return { outcome: 'BLOCKED', kind, reasons, warnings: [], ...extra };
}

// Rows are evaluated in spec order (§7); the first match wins.
export function decide({ agent, reportText, commits, diff, checks, config }) {
  if (agent.timedOut) return blocked('agent', ['agent timed out before finishing']);
  if (agent.exitCode !== 0) return blocked('agent', [`agent exited with code ${agent.exitCode}`]);

  if (reportText == null) return blocked('harness', ['agent wrote no report']);
  const parsed = parseReport(reportText);
  if (!parsed.ok) return blocked('harness', parsed.errors.map((e) => `report: ${e}`));
  const report = parsed.report;

  if (report.status === 'BLOCKED') return blocked('report', [report.blocker], { report });
  if (commits === 0) return blocked('gate', ['report says READY_FOR_QA but the branch has no commits'], { report });

  const touched = diff.flatMap((d) => (d.oldPath ? [d.oldPath, d.path] : [d.path]));
  const protectedHits = [...new Set(touched.filter((p) => matchesAny(p, config.protectedPaths)))];
  if (protectedHits.length) {
    return blocked('gate', [`changes touch protected paths: ${protectedHits.join(', ')}`], { report });
  }

  const removedTests = diff
    .filter((d) => (d.status === 'D' && matchesAny(d.path, config.testGlobs)) || (d.status === 'R' && matchesAny(d.oldPath, config.testGlobs)))
    .map((d) => (d.status === 'R' ? d.oldPath : d.path));
  if (removedTests.length) {
    return blocked('gate', [`existing tests deleted or renamed: ${removedTests.join(', ')}`], { report });
  }

  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([name]) => name);
  if (failed.length) {
    return blocked(
      'gate',
      failed.map((n) => (report.checks[n] === 'PASS' ? `check "${n}" failed (report claimed PASS)` : `check "${n}" failed`)),
      { report },
    );
  }

  const warnings = [];
  for (const name of Object.keys(checks)) {
    if (report.checks[name] !== 'PASS') {
      warnings.push(`report listed check "${name}" as ${report.checks[name] ?? 'missing'}, but it passed when the harness ran it`);
    }
  }
  const actual = [...new Set(diff.map((d) => d.path))].sort();
  const claimed = [...new Set(report.changedFiles)].sort();
  if (actual.join('\n') !== claimed.join('\n')) warnings.push(`CHANGED_FILES does not match the diff (diff: ${actual.join(', ')})`);
  const deps = actual.filter((p) => MANIFESTS.includes(p.split('/').pop()));
  if (deps.length) warnings.push(`dependency files changed: ${deps.join(', ')}`);

  return { outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings, report };
}
```

- [ ] **Step 4: Run tests** — `npm test` → all PASS

- [ ] **Step 5: Commit**

```bash
git add harness/lib/gate.mjs test/gate.test.mjs
git commit -m "feat: deterministic gate decision table"
```

---

### Task 6: Queue selection, upstream check, stacking

**Files:**
- Create: `harness/lib/queue.mjs`
- Test: `test/queue.test.mjs`

**Interfaces:**
- Consumes: `parseTaskRef` (Task 3).
- Produces:
  - `taskMarker({ plan, task, issue }): string` → `<!-- agent-task plan=<plan> task=<n> issue=<n> -->`
  - `parseTaskMarker(body: string): { plan, task: number, issue: number } | null`
  - `selectNext({ issues, prs, defaultBranch }): Selection` where `issues` are `gh issue list --json number,title,body,labels` rows (labels as `{name}` objects or strings), `prs` are `gh pr list --json number,headRefName,body` rows, and
    `Selection = { issue: null } | { issue: { number, title, body, labels: string[] }, plan: string|null, task: number|null, base: string, skip: string|null }`

- [ ] **Step 1: Write the failing test** — `test/queue.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNext, taskMarker, parseTaskMarker } from '../harness/lib/queue.mjs';

const issue = (number, task, labels, plan = 'docs/p.md') => ({
  number,
  title: `T${task}`,
  body: task == null ? 'no reference here' : `plan: ${plan}\ntask: ${task}`,
  labels: labels.map((name) => ({ name })),
});
const select = (issues, prs = []) => selectNext({ issues, prs, defaultBranch: 'main' });
const pr = (head, plan, task, issueNo) => ({ headRefName: head, body: `x\n${taskMarker({ plan, task, issue: issueNo })}` });

test('returns null when nothing is queued', () => {
  assert.deepEqual(select([issue(1, 1, ['agent:ready'])]), { issue: null });
});

test('orders by plan then task, not by issue number', () => {
  assert.equal(select([issue(5, 2, ['agent']), issue(9, 1, ['agent'])]).issue.number, 9);
  assert.equal(select([issue(1, 1, ['agent'], 'docs/b.md'), issue(2, 5, ['agent'], 'docs/a.md')]).issue.number, 2);
});

test('ignores issues already running', () => {
  assert.equal(select([issue(1, 1, ['agent', 'agent:running']), issue(2, 2, ['agent'])]).issue.number, 2);
});

test('bad references run first and carry a skip reason', () => {
  const s = select([issue(3, 1, ['agent']), issue(4, null, ['agent'])]);
  assert.equal(s.issue.number, 4);
  assert.match(s.skip, /^bad task reference: /);
});

test('stacks on the open agent PR of the highest earlier task in the same plan', () => {
  const prs = [
    pr('agent/issue-1', 'docs/p.md', 1, 1),
    pr('agent/issue-2', 'docs/p.md', 2, 2),
    pr('agent/issue-8', 'docs/other.md', 2, 8),
    { headRefName: 'feature/x', body: 'no marker' },
  ];
  const s = select([issue(3, 3, ['agent'])], prs);
  assert.equal(s.base, 'agent/issue-2');
  assert.equal(s.skip, null);
  assert.deepEqual([s.plan, s.task], ['docs/p.md', 3]);
});

test('falls back to the default branch', () => {
  assert.equal(select([issue(3, 3, ['agent'])], [pr('agent/issue-9', 'docs/p.md', 4, 9)]).base, 'main');
});

test('skips when an earlier task of the same plan is blocked', () => {
  const s = select([issue(1, 1, ['agent:blocked']), issue(2, 2, ['agent'])]);
  assert.equal(s.issue.number, 2);
  assert.equal(s.skip, 'upstream task 1 blocked (#1)');
});

test('a blocked task in another plan does not matter', () => {
  assert.equal(select([issue(1, 1, ['agent:blocked'], 'docs/x.md'), issue(2, 2, ['agent'])]).skip, null);
});

test('a re-queued blocked task runs first and is not its own upstream', () => {
  const s = select([issue(1, 1, ['agent', 'agent:blocked']), issue(2, 2, ['agent'])]);
  assert.equal(s.issue.number, 1);
  assert.equal(s.skip, null);
});

test('accepts plain string labels', () => {
  assert.equal(select([{ number: 1, title: 't', body: 'plan: p.md\ntask: 1', labels: ['agent'] }]).issue.number, 1);
});

test('task marker round trip', () => {
  assert.deepEqual(parseTaskMarker(`text\n${taskMarker({ plan: 'a.md', task: 4, issue: 9 })}`), { plan: 'a.md', task: 4, issue: 9 });
  assert.equal(parseTaskMarker('nothing'), null);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL (module not found)

- [ ] **Step 3: Implement** — `harness/lib/queue.mjs`

```js
import { parseTaskRef } from './issue.mjs';

const MARKER_RE = /<!-- agent-task plan=(\S+) task=(\d+) issue=(\d+) -->/;

export function taskMarker({ plan, task, issue }) {
  return `<!-- agent-task plan=${plan} task=${task} issue=${issue} -->`;
}

export function parseTaskMarker(body) {
  const m = MARKER_RE.exec(String(body ?? ''));
  return m ? { plan: m[1], task: Number(m[2]), issue: Number(m[3]) } : null;
}

const labelNames = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

export function selectNext({ issues, prs, defaultBranch }) {
  const all = issues.map((i) => ({ ...i, labels: labelNames(i.labels), ref: parseTaskRef(i.body) }));
  const queued = all.filter((i) => i.labels.includes('agent') && !i.labels.includes('agent:running'));
  if (queued.length === 0) return { issue: null };

  queued.sort((a, b) => {
    const aBad = Boolean(a.ref.error);
    const bBad = Boolean(b.ref.error);
    if (aBad !== bBad) return aBad ? -1 : 1;
    if (aBad) return a.number - b.number;
    return a.ref.plan.localeCompare(b.ref.plan) || a.ref.task - b.ref.task || a.number - b.number;
  });

  const next = queued[0];
  const issue = { number: next.number, title: next.title, body: next.body, labels: next.labels };
  if (next.ref.error) {
    return { issue, plan: null, task: null, base: defaultBranch, skip: `bad task reference: ${next.ref.error}` };
  }

  const { plan, task } = next.ref;
  const upstream = all
    .filter((i) => i.labels.includes('agent:blocked') && !i.ref.error && i.ref.plan === plan && i.ref.task < task)
    .sort((a, b) => a.ref.task - b.ref.task)[0];
  if (upstream) {
    return { issue, plan, task, base: defaultBranch, skip: `upstream task ${upstream.ref.task} blocked (#${upstream.number})` };
  }

  const parent = prs
    .map((p) => ({ head: p.headRefName, marker: parseTaskMarker(p.body) }))
    .filter((p) => p.marker && p.marker.plan === plan && p.marker.task < task)
    .sort((a, b) => b.marker.task - a.marker.task)[0];

  return { issue, plan, task, base: parent ? parent.head : defaultBranch, skip: null };
}
```

- [ ] **Step 4: Run tests** — `npm test` → all PASS

- [ ] **Step 5: Commit**

```bash
git add harness/lib/queue.mjs test/queue.test.mjs
git commit -m "feat: queue selection with upstream check and PR stacking"
```

---

### Task 7: PR body and issue comment rendering

**Files:**
- Create: `harness/lib/format.mjs`
- Test: `test/format.test.mjs`

**Interfaces:**
- Consumes: `taskMarker` (Task 6). A `Verdict` object (produced in Task 10):
  `{ outcome, kind, reasons, warnings, issue, issueTitle, plan, task, taskTitle, baseBranch, branch, model, commits, checks: Record<string,{ok,exitCode,timedOut,durationSec}>, report: Report|null, reportText: string|null }`
- Produces: `renderPrBody(verdict): string`; `renderComment(verdict, { runUrl, prUrl? }): string`

- [ ] **Step 1: Write the failing test** — `test/format.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrBody, renderComment } from '../harness/lib/format.mjs';
import { parseTaskMarker } from '../harness/lib/queue.mjs';

const readyVerdict = {
  outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings: ['dependency files changed: package.json'],
  issue: 7, issueTitle: 'Task 1', plan: 'docs/p.md', task: 1, taskTitle: 'Add greeting',
  baseBranch: 'main', branch: 'agent/issue-7', model: 'sonnet', commits: 2,
  checks: { test: { ok: true, exitCode: 0, timedOut: false, durationSec: 3 } },
  report: { summary: 'Added greeting.', selfReview: 'Scoped.', knownIssues: 'None' },
  reportText: 'STATUS: READY_FOR_QA\n',
};

test('PR body carries the marker, issue link, checks and warnings', () => {
  const body = renderPrBody(readyVerdict);
  assert.deepEqual(parseTaskMarker(body), { plan: 'docs/p.md', task: 1, issue: 7 });
  assert.match(body, /Closes #7/);
  assert.match(body, /\| test \| PASS \|/);
  assert.match(body, /## Warnings\n- dependency files changed: package\.json/);
  assert.match(body, /Added greeting\./);
});

test('ready comment links the PR and the run', () => {
  const c = renderComment(readyVerdict, { runUrl: 'https://run', prUrl: 'https://pr' });
  assert.match(c, /READY_FOR_QA/);
  assert.match(c, /https:\/\/pr/);
  assert.match(c, /https:\/\/run/);
});

test('blocked comment from the agent shows evidence, action, checks and branch', () => {
  const c = renderComment({
    ...readyVerdict, outcome: 'BLOCKED', kind: 'report', reasons: ['No secret.'], warnings: [], commits: 1,
    checks: { test: { ok: false, exitCode: null, timedOut: true, durationSec: 600 } },
    report: { status: 'BLOCKED', evidence: '$ echo $KEY', requiredHumanAction: 'Set KEY.' },
  }, { runUrl: 'https://run' });
  assert.match(c, /BLOCKED\*\* \(report\)/);
  assert.match(c, /- No secret\./);
  assert.match(c, /\$ echo \$KEY/);
  assert.match(c, /Set KEY\./);
  assert.match(c, /\| test \| TIMEOUT \|/);
  assert.match(c, /pushed to `agent\/issue-7`/);
  assert.match(c, /remove `agent:blocked` and add `agent`/);
});

test('blocked comment without a report or commits stays short', () => {
  const c = renderComment({ ...readyVerdict, outcome: 'BLOCKED', kind: 'gate', reasons: ['base is red: test failed before the agent started'], warnings: [], commits: 0, checks: {}, report: null }, { runUrl: 'https://run' });
  assert.doesNotMatch(c, /Evidence/);
  assert.doesNotMatch(c, /pushed to/);
  assert.match(c, /base is red/);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL (module not found)

- [ ] **Step 3: Implement** — `harness/lib/format.mjs`

```js
import { taskMarker } from './queue.mjs';

function checkTable(checks) {
  const rows = Object.entries(checks ?? {}).map(([name, c]) => {
    const result = c.ok ? 'PASS' : c.timedOut ? 'TIMEOUT' : `FAIL (exit ${c.exitCode})`;
    return `| ${name} | ${result} |`;
  });
  return ['| Check | Result |', '|---|---|', ...rows].join('\n');
}

const bullets = (items) => items.map((x) => `- ${x}`).join('\n');

export function renderPrBody(v) {
  const r = v.report;
  return [
    taskMarker({ plan: v.plan, task: v.task, issue: v.issue }),
    `Closes #${v.issue}`,
    '',
    `**Task ${v.task}: ${v.taskTitle}** — \`${v.plan}\``,
    `Base: \`${v.baseBranch}\` · Model: \`${v.model}\` · Commits: ${v.commits}`,
    '',
    '## Summary',
    r.summary,
    '',
    '## Checks (run by the harness)',
    checkTable(v.checks),
    ...(v.warnings.length ? ['', '## Warnings', bullets(v.warnings)] : []),
    '',
    '## Self-review',
    r.selfReview,
    '',
    '## Known issues',
    r.knownIssues,
    '',
    '<details><summary>Agent report</summary>',
    '',
    '~~~',
    (v.reportText ?? '').trim(),
    '~~~',
    '',
    '</details>',
  ].join('\n');
}

export function renderComment(v, { runUrl, prUrl } = {}) {
  if (v.outcome === 'READY_FOR_QA') {
    return `✅ **READY_FOR_QA** — ${prUrl ?? 'PR opened'}\n\n[Run log and artifacts](${runUrl})`;
  }
  const lines = [`⛔ **BLOCKED** (${v.kind})`, '', bullets(v.reasons)];
  const r = v.report;
  if (r?.status === 'BLOCKED') {
    lines.push('', '**Evidence**', '~~~', r.evidence, '~~~', '', '**Required human action**', r.requiredHumanAction);
  }
  if (v.checks && Object.keys(v.checks).length) lines.push('', checkTable(v.checks));
  if (v.warnings?.length) lines.push('', '**Warnings**', bullets(v.warnings));
  if (v.commits > 0) lines.push('', `The attempt was pushed to \`${v.branch}\` for inspection.`);
  lines.push('', `[Run log and artifacts](${runUrl})`, '', 'To retry: remove `agent:blocked` and add `agent`.');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests** — `npm test` → all PASS

- [ ] **Step 5: Commit**

```bash
git add harness/lib/format.mjs test/format.test.mjs
git commit -m "feat: render PR bodies and issue comments"
```

---

### Task 8: Command runner with process-group timeouts

**Files:**
- Create: `harness/lib/run-cmd.mjs`
- Test: `test/run-cmd.test.mjs`

**Interfaces:**
- Produces: `runWithTimeout(command: string | string[], { cwd, timeoutSec, logFile, env? }): Promise<{ exitCode: number, timedOut: boolean, durationSec: number }>`. A string runs via `sh -c`. stdout+stderr append to `logFile`. The whole process group is SIGKILLed on timeout **and** after the command exits (no leftover background processes). Spawn failure → `exitCode: 127`.

- [ ] **Step 1: Write the failing test** — `test/run-cmd.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithTimeout } from '../harness/lib/run-cmd.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'runcmd-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('captures exit code and output', async () => {
  const dir = tempDir();
  const r = await runWithTimeout('echo hi; echo err >&2; exit 3', { cwd: dir, timeoutSec: 5, logFile: join(dir, 'out.log') });
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
  assert.match(readFileSync(join(dir, 'out.log'), 'utf8'), /hi\nerr/);
});

test('kills the whole process group on timeout', async () => {
  const dir = tempDir();
  const started = Date.now();
  const r = await runWithTimeout('sleep 30 & sleep 30', { cwd: dir, timeoutSec: 1, logFile: join(dir, 'out.log') });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000, 'returned promptly');
});

test('kills background children left behind after a normal exit', async () => {
  const dir = tempDir();
  const r = await runWithTimeout('sleep 30 & echo $! > pid', { cwd: dir, timeoutSec: 5, logFile: join(dir, 'out.log') });
  assert.equal(r.exitCode, 0);
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
  await sleep(300);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('accepts argv arrays and reports spawn failures as 127', async () => {
  const dir = tempDir();
  const ok = await runWithTimeout(['sh', '-c', 'exit 0'], { cwd: dir, timeoutSec: 5, logFile: join(dir, 'a.log') });
  assert.equal(ok.exitCode, 0);
  const missing = await runWithTimeout(['definitely-not-a-command-xyz'], { cwd: dir, timeoutSec: 5, logFile: join(dir, 'b.log') });
  assert.equal(missing.exitCode, 127);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL (module not found)

- [ ] **Step 3: Implement** — `harness/lib/run-cmd.mjs`

```js
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync } from 'node:fs';
import { constants } from 'node:os';

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // group already gone
  }
}

export function runWithTimeout(command, { cwd, timeoutSec, logFile, env = process.env }) {
  const argv = Array.isArray(command) ? command : ['sh', '-c', command];
  const fd = openSync(logFile, 'a');
  const started = Date.now();

  return new Promise((resolve) => {
    let timedOut = false;
    let finished = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', fd, fd], detached: true });

    const finish = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.pid) killGroup(child.pid);
      closeSync(fd);
      resolve({ exitCode, timedOut, durationSec: Math.round((Date.now() - started) / 1000) });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killGroup(child.pid);
    }, timeoutSec * 1000);

    child.on('error', (err) => {
      writeSync(fd, `\n[harness] failed to start ${argv[0]}: ${err.message}\n`);
      finish(127);
    });
    child.on('exit', (code, signal) => finish(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
}
```

- [ ] **Step 4: Run tests** — `npm test` → all PASS

- [ ] **Step 5: Commit**

```bash
git add harness/lib/run-cmd.mjs test/run-cmd.test.mjs
git commit -m "feat: command runner with process-group timeouts"
```

---

### Task 9: Agent invocation and prompt

**Files:**
- Create: `harness/lib/agent.mjs`, `harness/prompt.md`
- Test: `test/agent.test.mjs`

**Interfaces:**
- Produces:
  - `ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash'`
  - `agentEnv(source: object, extra: object): object` — copies only `PATH, HOME, USER, LANG, LC_ALL, TERM, TMPDIR, SHELL, CI, CLAUDE_CODE_OAUTH_TOKEN` from `source`, then merges `extra`.
  - `agentCommand({ model, maxTurns, promptText, override? }): string[]` — `override` (the `AGENT_CMD` value) yields `['sh', '-c', override]`.
  - `renderPrompt(template: string, vars: object): string` — replaces `{{NAME}}`; throws on unknown names.
  - `harness/prompt.md` variables: `ISSUE, PLAN, TASK, TASK_TITLE, REPORT_PATH, BRANCH, CHECKS, PROTECTED`.

- [ ] **Step 1: Write the failing test** — `test/agent.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentEnv, agentCommand, renderPrompt, ALLOWED_TOOLS } from '../harness/lib/agent.mjs';

test('agentEnv keeps only allowlisted variables plus extras', () => {
  const env = agentEnv(
    { PATH: '/bin', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'tok', GITHUB_TOKEN: 'gh', GH_TOKEN: 'gh', ACTIONS_RUNTIME_TOKEN: 'rt' },
    { REPORT_PATH: '/r' },
  );
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'tok', REPORT_PATH: '/r' });
});

test('agentCommand builds the claude invocation', () => {
  assert.equal(ALLOWED_TOOLS, 'Read,Edit,Write,Glob,Grep,Bash');
  assert.deepEqual(agentCommand({ model: 'sonnet', maxTurns: 150, promptText: 'do it' }), [
    'claude', '-p', 'do it', '--model', 'sonnet', '--max-turns', '150',
    '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash', '--output-format', 'stream-json', '--verbose',
  ]);
});

test('AGENT_CMD override replaces claude', () => {
  assert.deepEqual(agentCommand({ model: 'sonnet', maxTurns: 1, promptText: 'x', override: 'sh fake.sh' }), ['sh', '-c', 'sh fake.sh']);
});

test('renderPrompt substitutes and rejects unknown variables', () => {
  assert.equal(renderPrompt('Task {{TASK}} of {{PLAN}}', { TASK: 3, PLAN: 'p.md' }), 'Task 3 of p.md');
  assert.throws(() => renderPrompt('{{NOPE}}', {}), /unknown variable NOPE/);
});

test('the shipped prompt uses only the documented variables', () => {
  const template = readFileSync(new URL('../harness/prompt.md', import.meta.url), 'utf8');
  const out = renderPrompt(template, {
    ISSUE: 7, PLAN: 'docs/p.md', TASK: 1, TASK_TITLE: 'Add greeting', REPORT_PATH: '/tmp/report.md',
    BRANCH: 'agent/issue-7', CHECKS: '- test: `npm test`', PROTECTED: '`.github/**`',
  });
  assert.match(out, /\/tmp\/report\.md/);
  assert.doesNotMatch(out, /\{\{/);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL (module not found)

- [ ] **Step 3: Implement** — `harness/lib/agent.mjs`

```js
export const ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';

// The agent must never see a GitHub token; only these variables pass through.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'CI', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function agentEnv(source, extra) {
  const env = {};
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, ...extra };
}

export function agentCommand({ model, maxTurns, promptText, override }) {
  if (override) return ['sh', '-c', override];
  return [
    'claude', '-p', promptText,
    '--model', model,
    '--max-turns', String(maxTurns),
    '--allowedTools', ALLOWED_TOOLS,
    '--output-format', 'stream-json',
    '--verbose',
  ];
}

export function renderPrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`prompt template uses unknown variable ${name}`);
    return String(vars[name]);
  });
}
```

- [ ] **Step 4: Write the prompt** — `harness/prompt.md`

```markdown
You are executing one task from an implementation plan, unattended. No human will answer questions during this run.

- Task: Task {{TASK}} — {{TASK_TITLE}}
- Plan file: {{PLAN}} (relative to the repository root, which is your working directory)
- Issue: #{{ISSUE}}
- Branch: {{BRANCH}} (already checked out; stay on it)

## What to do

1. Read the plan file: its header sections (goal, architecture, global constraints) and Task {{TASK}} in full. Implement only Task {{TASK}}.
2. Follow the task's steps, including its tests and verification commands.
3. Run every project check before reporting:
{{CHECKS}}
4. Commit your work on this branch with clear messages. Do not push and do not open pull requests.
5. Write the report described below to {{REPORT_PATH}}.

## Rules

- Do only what Task {{TASK}} asks. No unrelated refactoring, renames, or formatting changes.
- Never delete, skip, or weaken existing tests or assertions to get a green result.
- Never modify these protected paths: {{PROTECTED}}.
- Wrap every test, build, or lint command in `timeout 600`, for example `timeout 600 pnpm test`.
- Never start dev servers, watchers, or any process that does not exit on its own.
- Earlier tasks of this plan may already be implemented in this branch's history; build on them.
- If the plan does not match the code, a dependency or secret is missing, or the task cannot be done safely, stop and report BLOCKED with evidence. Do not improvise around the plan.

## Report format

Write exactly these fields to {{REPORT_PATH}}, each field name at the start of a line:

STATUS: READY_FOR_QA or BLOCKED
TASK: plan={{PLAN}} task={{TASK}} issue=#{{ISSUE}}
SUMMARY:
<2-5 lines>
CHANGED_FILES:
- <one path per line: every file changed by your commits>
CHECKS:
- <check name>: PASS or FAIL or NOT_RUN   (one line per project check listed above)
SELF_REVIEW:
<scope respected? tests added? risks?>
KNOWN_ISSUES:
<text, or None>

When STATUS is BLOCKED, also include:

BLOCKER:
<what stopped you, one or two lines>
EVIDENCE:
<the command you ran and the relevant output>
REQUIRED_HUMAN_ACTION:
<what the human must do before this task can be retried>

The harness re-runs every check itself after you finish and compares the results with your report. A report that claims PASS for a failing check is rejected.
```

- [ ] **Step 5: Run tests** — `npm test` → all PASS

- [ ] **Step 6: Commit**

```bash
git add harness/lib/agent.mjs harness/prompt.md test/agent.test.mjs
git commit -m "feat: agent invocation, env allowlist and prompt"
```

---

### Task 10: `run-task.mjs` orchestration with fake-agent pipeline tests

**Files:**
- Create: `harness/run-task.mjs`
- Create fixture project: `test/fixtures/project/agent.config.json`, `test/fixtures/project/value.txt`, `test/fixtures/project/lint.sh`, `test/fixtures/project/tests/run.sh`, `test/fixtures/project/tests/base.test.sh`, `test/fixtures/project/docs/plan.md`
- Create fake agents: `test/fake-agents/lib.sh`, `honest.sh`, `liar.sh`, `delete-test.sh`, `edit-ci.sh`, `hang.sh`, `no-report.sh`, `blocked.sh`, `dirty.sh`
- Test: `test/pipeline.test.mjs`

**Interfaces:**
- Consumes: `loadConfig` (T2), `parseTaskRef`, `findTaskHeading` (T3), `decide` (T5), `runWithTimeout` (T8), `agentEnv`, `agentCommand`, `renderPrompt` (T9).
- Produces:
  - `parseDiff(nameStatusOutput: string): Array<{ status, path, oldPath? }>`
  - `runTask({ projectDir, issue: { number, title, body, labels: string[] }, outDir, baseBranch, env? }): Promise<Verdict>` — always writes `<outDir>/verdict.json`; also writes `<outDir>/prompt.md`, `<outDir>/report.md` (by the agent), `<outDir>/logs/*.log`. Uses `env.AGENT_CMD` to replace Claude.
  - CLI: `node harness/run-task.mjs --project <dir> --issue <issue.json> --out <dir> --base-branch <name>` (exit 0 whenever a verdict was written).
  - `Verdict` fields as listed in Task 7, plus `diff` and `baseSha`.

- [ ] **Step 1: Create the fixture project**

`test/fixtures/project/agent.config.json`:
```json
{
  "install": "true",
  "checks": { "test": "sh tests/run.sh", "lint": "sh lint.sh" },
  "timeouts": { "install": "30s", "claude": "3s", "check": "10s" },
  "testGlobs": ["tests/**"]
}
```

`test/fixtures/project/value.txt`:
```
1
```

`test/fixtures/project/lint.sh`:
```sh
if grep -rn TODO --include='*.txt' .; then exit 1; fi
```

`test/fixtures/project/tests/run.sh`:
```sh
for t in tests/*.test.sh; do
  sh "$t" || { echo "FAIL $t"; exit 1; }
done
```

`test/fixtures/project/tests/base.test.sh`:
```sh
test "$(cat value.txt)" = "1"
```

`test/fixtures/project/docs/plan.md`:
```markdown
# Fixture Plan

## Task 1: Add greeting

Create `greeting.txt` containing `hello`, with a test in `tests/greeting.test.sh`.
```

- [ ] **Step 2: Create the fake agents** (each runs with cwd = project, `$REPORT_PATH` set)

`test/fake-agents/lib.sh`:
```sh
# Shared helper for fake agents: write a READY_FOR_QA report listing the given files.
ready_report() {
  {
    echo "STATUS: READY_FOR_QA"
    echo "TASK: plan=docs/plan.md task=1 issue=#7"
    echo "SUMMARY:"
    echo "Did the task."
    echo "CHANGED_FILES:"
    for f in "$@"; do echo "- $f"; done
    echo "CHECKS:"
    echo "- test: PASS"
    echo "- lint: PASS"
    echo "SELF_REVIEW:"
    echo "Looks fine."
    echo "KNOWN_ISSUES:"
    echo "None"
  } > "$REPORT_PATH"
}
```

`test/fake-agents/honest.sh`:
```sh
set -e
. "$(dirname "$0")/lib.sh"
echo hello > greeting.txt
echo 'test "$(cat greeting.txt)" = "hello"' > tests/greeting.test.sh
git add -A
git commit -qm "Add greeting"
ready_report greeting.txt tests/greeting.test.sh
```

`test/fake-agents/liar.sh`:
```sh
set -e
. "$(dirname "$0")/lib.sh"
echo 2 > value.txt
git commit -qam "Change value"
ready_report value.txt
```

`test/fake-agents/delete-test.sh`:
```sh
set -e
. "$(dirname "$0")/lib.sh"
git rm -q tests/base.test.sh
git commit -qm "Remove inconvenient test"
ready_report tests/base.test.sh
```

`test/fake-agents/edit-ci.sh`:
```sh
set -e
. "$(dirname "$0")/lib.sh"
mkdir -p .github/workflows
echo "name: x" > .github/workflows/x.yml
git add -A
git commit -qm "Touch CI"
ready_report .github/workflows/x.yml
```

`test/fake-agents/hang.sh`:
```sh
sleep 30
```

`test/fake-agents/no-report.sh`:
```sh
set -e
echo hello > greeting.txt
git add -A
git commit -qm "Add greeting"
```

`test/fake-agents/blocked.sh`:
```sh
cat > "$REPORT_PATH" <<'EOF'
STATUS: BLOCKED
TASK: plan=docs/plan.md task=1 issue=#7
BLOCKER:
Needs a secret that does not exist.
EVIDENCE:
$ echo $DEPLOY_KEY
(empty)
REQUIRED_HUMAN_ACTION:
Provide DEPLOY_KEY.
EOF
```

`test/fake-agents/dirty.sh`:
```sh
set -e
. "$(dirname "$0")/lib.sh"
echo 'test "$(cat greeting.txt)" = "hello"' > tests/greeting.test.sh
git add tests/greeting.test.sh
git commit -qm "Add greeting test"
echo hello > greeting.txt
ready_report greeting.txt tests/greeting.test.sh
```
(`greeting.txt` is deliberately left uncommitted.)

- [ ] **Step 3: Write the failing pipeline test** — `test/pipeline.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTask, parseDiff } from '../harness/run-task.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, 'fake-agents');
const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

function makeProject(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-project-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  if (mutate) {
    mutate(dir, git);
    git('commit', '-qam', 'mutate');
  }
  return dir;
}

async function run({ agent, cmd, issue = ISSUE, mutate } = {}) {
  const projectDir = makeProject(mutate);
  const outDir = mkdtempSync(join(tmpdir(), 'harness-out-'));
  const AGENT_CMD = cmd ?? `sh "${join(AGENTS, agent)}"`;
  const verdict = await runTask({ projectDir, issue, outDir, baseBranch: 'main', env: { ...process.env, AGENT_CMD } });
  return { verdict, projectDir, outDir };
}

test('parseDiff handles adds, deletes and renames', () => {
  assert.deepEqual(parseDiff('A\ta.txt\nD\tb.txt\nR100\told.txt\tnew.txt\n'), [
    { status: 'A', path: 'a.txt' },
    { status: 'D', path: 'b.txt' },
    { status: 'R', oldPath: 'old.txt', path: 'new.txt' },
  ]);
});

test('honest agent → READY_FOR_QA with a written verdict', async () => {
  const { verdict, outDir, projectDir } = await run({ agent: 'honest.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.equal(verdict.commits, 1);
  assert.deepEqual(verdict.warnings, []);
  assert.equal(verdict.taskTitle, 'Add greeting');
  assert.equal(verdict.branch, 'agent/issue-7');
  assert.equal(verdict.model, 'sonnet');
  assert.deepEqual(Object.keys(verdict.checks), ['test', 'lint']);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'verdict.json'), 'utf8')).outcome, 'READY_FOR_QA');
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim();
  assert.equal(branch, 'agent/issue-7');
});

test('agent:opus label switches the model', async () => {
  const { verdict } = await run({ agent: 'honest.sh', issue: { ...ISSUE, labels: ['agent', 'agent:opus'] } });
  assert.equal(verdict.model, 'opus');
});

test('liar → blocked by the real check', async () => {
  const { verdict } = await run({ agent: 'liar.sh' });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'gate');
  assert.deepEqual(verdict.reasons, ['check "test" failed (report claimed PASS)']);
});

test('deleting a test → blocked', async () => {
  const { verdict } = await run({ agent: 'delete-test.sh' });
  assert.match(verdict.reasons[0], /existing tests deleted or renamed: tests\/base\.test\.sh/);
});

test('editing CI → blocked', async () => {
  const { verdict } = await run({ agent: 'edit-ci.sh' });
  assert.match(verdict.reasons[0], /protected paths: \.github\/workflows\/x\.yml/);
});

test('hanging agent → killed at the timeout', async () => {
  const started = Date.now();
  const { verdict } = await run({ agent: 'hang.sh' });
  assert.equal(verdict.kind, 'agent');
  assert.match(verdict.reasons[0], /timed out/);
  assert.deepEqual(verdict.checks, {});
  assert.ok(Date.now() - started < 15000);
});

test('no report → blocked by the harness', async () => {
  const { verdict } = await run({ agent: 'no-report.sh' });
  assert.equal(verdict.kind, 'harness');
  assert.deepEqual(verdict.reasons, ['agent wrote no report']);
  assert.equal(verdict.commits, 1);
});

test('agent reports BLOCKED → its blocker is surfaced', async () => {
  const { verdict } = await run({ agent: 'blocked.sh' });
  assert.equal(verdict.kind, 'report');
  assert.deepEqual(verdict.reasons, ['Needs a secret that does not exist.']);
  assert.equal(verdict.report.requiredHumanAction, 'Provide DEPLOY_KEY.');
});

test('uncommitted changes are not counted → blocked, with a warning', async () => {
  const { verdict } = await run({ agent: 'dirty.sh' });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.deepEqual(verdict.reasons, ['check "test" failed (report claimed PASS)']);
  assert.match(verdict.warnings.join('\n'), /uncommitted changes/);
});

test('red base → blocked before the agent runs', async () => {
  const { verdict, projectDir } = await run({
    cmd: 'touch agent-ran',
    mutate: (dir) => writeFileSync(join(dir, 'value.txt'), '2\n'),
  });
  assert.equal(verdict.kind, 'gate');
  assert.equal(verdict.reasons[0], 'base is red: test failed before the agent started');
  assert.equal(existsSync(join(projectDir, 'agent-ran')), false);
});

test('unknown task number → bad task reference', async () => {
  const { verdict } = await run({ agent: 'honest.sh', issue: { ...ISSUE, body: 'plan: docs/plan.md\ntask: 9' } });
  assert.equal(verdict.kind, 'gate');
  assert.match(verdict.reasons[0], /no "Task 9:" heading in docs\/plan\.md/);
});

test('missing plan file → bad task reference', async () => {
  const { verdict } = await run({ agent: 'honest.sh', issue: { ...ISSUE, body: 'plan: docs/nope.md\ntask: 1' } });
  assert.match(verdict.reasons[0], /plan file not found: docs\/nope\.md/);
});

test('missing agent.config.json → blocked by the harness', async () => {
  const { verdict } = await run({ agent: 'honest.sh', mutate: (dir, git) => git('rm', '-q', 'agent.config.json') });
  assert.equal(verdict.kind, 'harness');
  assert.match(verdict.reasons[0], /agent\.config\.json not found/);
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../harness/run-task.mjs`

- [ ] **Step 5: Implement** — `harness/run-task.mjs`

```js
#!/usr/bin/env node
// Runs one task locally and writes verdict.json. Network-free: GitHub
// interaction (select, claim, publish) happens in the workflow around it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './lib/config.mjs';
import { parseTaskRef, findTaskHeading } from './lib/issue.mjs';
import { decide } from './lib/gate.mjs';
import { runWithTimeout } from './lib/run-cmd.mjs';
import { agentCommand, agentEnv, renderPrompt } from './lib/agent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const blocked = (kind, reason) => ({ outcome: 'BLOCKED', kind, reasons: [reason], warnings: [] });

export function parseDiff(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, a, b] = line.split('\t');
      const s = status[0];
      return s === 'R' || s === 'C' ? { status: s, oldPath: a, path: b } : { status: s, path: a };
    });
}

async function runChecks(config, projectDir, logsDir, phase, env) {
  const results = {};
  for (const [name, cmd] of Object.entries(config.checks)) {
    const r = await runWithTimeout(cmd, {
      cwd: projectDir,
      timeoutSec: config.timeouts.check,
      logFile: join(logsDir, `${phase}-${name}.log`),
      env,
    });
    results[name] = { ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, timedOut: r.timedOut, durationSec: r.durationSec };
  }
  return results;
}

export async function runTask({ projectDir, issue, outDir, baseBranch, env = process.env }) {
  projectDir = resolve(projectDir);
  outDir = resolve(outDir);
  const logsDir = join(outDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const reportPath = join(outDir, 'report.md');
  rmSync(reportPath, { force: true });

  const meta = {
    issue: issue.number, issueTitle: issue.title, baseBranch, branch: `agent/issue-${issue.number}`,
    plan: null, task: null, taskTitle: null, model: null, commits: 0, checks: {}, report: null, reportText: null,
  };
  const finish = (result) => {
    const verdict = { ...meta, ...result };
    writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
    return verdict;
  };
  // Install and checks run project code: give them no tokens at all.
  const quietEnv = agentEnv(env, {});
  delete quietEnv.CLAUDE_CODE_OAUTH_TOKEN;

  const configPath = join(projectDir, 'agent.config.json');
  if (!existsSync(configPath)) return finish(blocked('harness', 'agent.config.json not found in project root'));
  let config;
  try {
    config = loadConfig(readFileSync(configPath, 'utf8'));
  } catch (e) {
    return finish(blocked('harness', `invalid agent.config.json: ${e.message}`));
  }

  const ref = parseTaskRef(issue.body);
  if (ref.error) return finish(blocked('gate', `bad task reference: ${ref.error}`));
  meta.plan = ref.plan;
  meta.task = ref.task;
  const planPath = join(projectDir, ref.plan);
  if (!existsSync(planPath)) return finish(blocked('gate', `bad task reference: plan file not found: ${ref.plan}`));
  meta.taskTitle = findTaskHeading(readFileSync(planPath, 'utf8'), ref.task);
  if (!meta.taskTitle) return finish(blocked('gate', `bad task reference: no "Task ${ref.task}:" heading in ${ref.plan}`));
  meta.model = issue.labels.includes('agent:opus') ? 'opus' : config.model;

  git(projectDir, 'checkout', '-q', '-B', meta.branch);
  git(projectDir, 'config', 'user.name', 'agent-harness');
  git(projectDir, 'config', 'user.email', 'agent-harness@users.noreply.github.com');

  const install = await runWithTimeout(config.install, {
    cwd: projectDir, timeoutSec: config.timeouts.install, logFile: join(logsDir, 'install.log'), env: quietEnv,
  });
  if (install.timedOut || install.exitCode !== 0) {
    return finish(blocked('harness', install.timedOut ? 'install timed out' : `install failed (exit ${install.exitCode})`));
  }

  const baseline = await runChecks(config, projectDir, logsDir, 'baseline', quietEnv);
  const red = Object.entries(baseline).filter(([, c]) => !c.ok).map(([name]) => name);
  if (red.length) {
    return finish({ ...blocked('gate', `base is red: ${red.join(', ')} failed before the agent started`), checks: baseline });
  }

  const baseSha = git(projectDir, 'rev-parse', 'HEAD');
  const dirtyBefore = git(projectDir, 'status', '--porcelain');
  const promptText = renderPrompt(readFileSync(join(HERE, 'prompt.md'), 'utf8'), {
    ISSUE: issue.number,
    PLAN: ref.plan,
    TASK: ref.task,
    TASK_TITLE: meta.taskTitle,
    REPORT_PATH: reportPath,
    BRANCH: meta.branch,
    CHECKS: Object.entries(config.checks).map(([name, cmd]) => `   - ${name}: \`${cmd}\``).join('\n'),
    PROTECTED: config.protectedPaths.map((p) => `\`${p}\``).join(', '),
  });
  const promptFile = join(outDir, 'prompt.md');
  writeFileSync(promptFile, promptText);

  const agent = await runWithTimeout(
    agentCommand({ model: meta.model, maxTurns: config.maxTurns, promptText, override: env.AGENT_CMD }),
    {
      cwd: projectDir,
      timeoutSec: config.timeouts.claude,
      logFile: join(logsDir, 'agent.log'),
      env: agentEnv(env, { REPORT_PATH: reportPath, PROMPT_FILE: promptFile }),
    },
  );

  const head = git(projectDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (head !== meta.branch) return finish(blocked('gate', `agent switched to branch "${head}"; work must stay on ${meta.branch}`));

  const warnings = [];
  const dirtyAfter = git(projectDir, 'status', '--porcelain');
  if (dirtyAfter) {
    if (dirtyAfter !== dirtyBefore) warnings.push('agent left uncommitted changes; they were stashed and are not part of this result');
    git(projectDir, 'stash', 'push', '--include-untracked', '-q', '-m', 'agent-harness: uncommitted changes');
  }

  const commits = Number(git(projectDir, 'rev-list', '--count', `${baseSha}..HEAD`));
  const diff = parseDiff(git(projectDir, 'diff', '--name-status', '-M', baseSha, 'HEAD'));
  const agentFailed = agent.timedOut || agent.exitCode !== 0;
  const checks = agentFailed ? {} : await runChecks(config, projectDir, logsDir, 'verify', quietEnv);
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;

  const decision = decide({ agent, reportText, commits, diff, checks, config });
  return finish({
    ...decision,
    warnings: [...warnings, ...decision.warnings],
    report: decision.report ?? null,
    reportText,
    commits,
    diff,
    checks,
    baseSha,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { project: { type: 'string' }, issue: { type: 'string' }, out: { type: 'string' }, 'base-branch': { type: 'string' } },
  });
  for (const key of ['project', 'issue', 'out', 'base-branch']) {
    if (!values[key]) {
      console.error(`missing --${key}`);
      process.exit(2);
    }
  }
  const verdict = await runTask({
    projectDir: values.project,
    issue: JSON.parse(readFileSync(values.issue, 'utf8')),
    outDir: values.out,
    baseBranch: values['base-branch'],
  });
  console.log(`${verdict.outcome}${verdict.kind ? ` (${verdict.kind})` : ''}: ${verdict.reasons.join('; ') || 'all checks passed'}`);
}
```

- [ ] **Step 6: Run tests** — `npm test` → all PASS (the hang scenario takes ~3s)

- [ ] **Step 7: Commit**

```bash
git add harness/run-task.mjs test/fixtures test/fake-agents test/pipeline.test.mjs
git commit -m "feat: run-task orchestration with fake-agent pipeline tests"
```

---

### Task 11: Workflow CLI (`cli.mjs`)

**Files:**
- Create: `harness/cli.mjs`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `selectNext` (T6), `renderPrBody`, `renderComment` (T7).
- Produces (stdout; exit 2 on usage errors):
  - `select --issues <f> --prs <f> --default-branch <b>` → `Selection` JSON
  - `skip-verdict --selection <f>` → `Verdict` JSON, `BLOCKED (gate)` with the selection's `skip` reason
  - `fallback-verdict --selection <f>` → `Verdict` JSON, `BLOCKED (harness)`: "the run ended without a verdict (crash or job timeout); see the run log"
  - `render-pr --verdict <f>` → markdown
  - `render-comment --verdict <f> --run-url <u> [--pr-url <u>]` → markdown

- [ ] **Step 1: Write the failing test** — `test/cli.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const CLI = new URL('../harness/cli.mjs', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'cli-'));
const file = (name, data) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(data));
  return p;
};
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const issues = file('issues.json', [{ number: 4, title: 'T', body: 'plan: docs/p.md\ntask: 2', labels: [{ name: 'agent' }] }]);
const prs = file('prs.json', []);

test('select prints the selection', () => {
  const s = JSON.parse(cli('select', '--issues', issues, '--prs', prs, '--default-branch', 'main'));
  assert.equal(s.issue.number, 4);
  assert.equal(s.base, 'main');
  assert.equal(s.skip, null);
});

test('skip-verdict and fallback-verdict produce publishable BLOCKED verdicts', () => {
  const selection = file('sel.json', { issue: { number: 4, title: 'T', body: '', labels: ['agent'] }, plan: 'docs/p.md', task: 2, base: 'main', skip: 'upstream task 1 blocked (#3)' });
  const skip = JSON.parse(cli('skip-verdict', '--selection', selection));
  assert.equal(skip.outcome, 'BLOCKED');
  assert.equal(skip.kind, 'gate');
  assert.deepEqual(skip.reasons, ['upstream task 1 blocked (#3)']);
  assert.equal(skip.issue, 4);
  assert.equal(skip.commits, 0);
  assert.equal(skip.branch, 'agent/issue-4');
  const fallback = JSON.parse(cli('fallback-verdict', '--selection', selection));
  assert.equal(fallback.kind, 'harness');
  assert.match(fallback.reasons[0], /ended without a verdict/);
});

test('render-comment prints markdown', () => {
  const selection = file('sel2.json', { issue: { number: 4, title: 'T', body: '', labels: [] }, plan: null, task: null, base: 'main', skip: 'bad task reference: x' });
  const verdict = join(dir, 'verdict.json');
  writeFileSync(verdict, cli('skip-verdict', '--selection', selection));
  const out = cli('render-comment', '--verdict', verdict, '--run-url', 'https://run');
  assert.match(out, /BLOCKED\*\* \(gate\)/);
  assert.match(out, /https:\/\/run/);
});

test('unknown command exits 2', () => {
  const r = spawnSync(process.execPath, [CLI, 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL (cli.mjs missing; `select` test errors)

- [ ] **Step 3: Implement** — `harness/cli.mjs`

```js
#!/usr/bin/env node
// Small commands the reusable workflow calls between gh steps.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { selectNext } from './lib/queue.mjs';
import { renderPrBody, renderComment } from './lib/format.mjs';

const USAGE = `usage:
  cli.mjs select --issues <f> --prs <f> --default-branch <b>
  cli.mjs skip-verdict --selection <f>
  cli.mjs fallback-verdict --selection <f>
  cli.mjs render-pr --verdict <f>
  cli.mjs render-comment --verdict <f> --run-url <u> [--pr-url <u>]`;

const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const print = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

function blockedVerdict(selection, kind, reason) {
  return {
    outcome: 'BLOCKED', kind, reasons: [reason], warnings: [],
    issue: selection.issue.number, issueTitle: selection.issue.title,
    plan: selection.plan, task: selection.task, taskTitle: null,
    baseBranch: selection.base, branch: `agent/issue-${selection.issue.number}`,
    model: null, commits: 0, checks: {}, report: null, reportText: null,
  };
}

const [command, ...rest] = process.argv.slice(2);
let values;
try {
  ({ values } = parseArgs({
    args: rest,
    options: {
      issues: { type: 'string' }, prs: { type: 'string' }, 'default-branch': { type: 'string' },
      selection: { type: 'string' }, verdict: { type: 'string' },
      'run-url': { type: 'string' }, 'pr-url': { type: 'string' },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n${USAGE}`);
  process.exit(2);
}

switch (command) {
  case 'select':
    print(selectNext({ issues: read(values.issues), prs: read(values.prs), defaultBranch: values['default-branch'] }));
    break;
  case 'skip-verdict': {
    const selection = read(values.selection);
    print(blockedVerdict(selection, 'gate', selection.skip));
    break;
  }
  case 'fallback-verdict':
    print(blockedVerdict(read(values.selection), 'harness', 'the run ended without a verdict (crash or job timeout); see the run log'));
    break;
  case 'render-pr':
    process.stdout.write(renderPrBody(read(values.verdict)));
    break;
  case 'render-comment':
    process.stdout.write(renderComment(read(values.verdict), { runUrl: values['run-url'], prUrl: values['pr-url'] }));
    break;
  default:
    console.error(USAGE);
    process.exit(2);
}
```

- [ ] **Step 4: Run tests** — `npm test` → all PASS

- [ ] **Step 5: Commit**

```bash
git add harness/cli.mjs test/cli.test.mjs
git commit -m "feat: workflow CLI for select, verdicts and rendering"
```

---

### Task 12: Publish script, reusable workflow, templates, README

**Files:**
- Create: `harness/publish.sh`, `.github/workflows/run-task.yml`
- Create: `templates/agent.yml`, `templates/agent.config.json`, `templates/agent-task.md`
- Create: `README.md`

**Interfaces:**
- Consumes: `harness/cli.mjs` commands (T11), `harness/run-task.mjs` CLI (T10).
- `publish.sh` env: `VERDICT` (path), `REPO` (`owner/name`), `GH_TOKEN`, `RUN_URL`, `PROJECT_DIR`.
- Reusable workflow inputs: `harness_repo` (required), `harness_ref` (default `v1`), `caller_workflow` (default `agent.yml`), `node_version` (default `'22'`); secret `CLAUDE_CODE_OAUTH_TOKEN` (required).

No automated test is possible for these files (they need GitHub); they are verified by `actionlint` here and by the real sandbox run in Task 13.

- [ ] **Step 1: Write** `harness/publish.sh`

```bash
#!/usr/bin/env bash
# Publishes a verdict: PR for READY_FOR_QA, issue comment for BLOCKED.
# Runs after the agent has exited; this is the only step holding a push-capable token.
set -euo pipefail
: "${VERDICT:?}" "${REPO:?}" "${GH_TOKEN:?}" "${RUN_URL:?}" "${PROJECT_DIR:?}"

CLI="$(cd "$(dirname "$0")" && pwd)/cli.mjs"
field() { jq -r "$1" "$VERDICT"; }

issue=$(field .issue)
outcome=$(field .outcome)
branch=$(field .branch)
base=$(field .baseBranch)
commits=$(field '.commits // 0')
task=$(field .task)
title=$(field .taskTitle)

gh issue edit "$issue" --repo "$REPO" \
  --remove-label agent:running --remove-label agent:ready --remove-label agent:blocked >/dev/null || true

push_branch() {
  git -C "$PROJECT_DIR" push --force --quiet \
    "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "HEAD:refs/heads/${branch}"
}

pr=""
if [ "$outcome" = "READY_FOR_QA" ]; then
  push_branch
  body=$(mktemp)
  node "$CLI" render-pr --verdict "$VERDICT" > "$body"
  pr=$(gh pr list --repo "$REPO" --head "$branch" --state open --json url -q '.[0].url // empty')
  if [ -n "$pr" ]; then
    gh pr edit "$pr" --repo "$REPO" --base "$base" --body-file "$body" >/dev/null
  else
    pr=$(gh pr create --repo "$REPO" --base "$base" --head "$branch" --title "Task ${task}: ${title}" --body-file "$body")
  fi
  gh issue edit "$issue" --repo "$REPO" --add-label agent:ready >/dev/null
else
  if [ "$commits" -gt 0 ] && [ -d "$PROJECT_DIR/.git" ]; then
    push_branch
  fi
  gh issue edit "$issue" --repo "$REPO" --add-label agent:blocked >/dev/null
fi

comment=$(mktemp)
if [ -n "$pr" ]; then
  node "$CLI" render-comment --verdict "$VERDICT" --run-url "$RUN_URL" --pr-url "$pr" > "$comment"
else
  node "$CLI" render-comment --verdict "$VERDICT" --run-url "$RUN_URL" > "$comment"
fi
gh issue comment "$issue" --repo "$REPO" --body-file "$comment" >/dev/null
echo "published ${outcome} for #${issue} ${pr}"
```

Run: `chmod +x harness/publish.sh harness/run-task.mjs harness/cli.mjs`

- [ ] **Step 2: Write** `.github/workflows/run-task.yml`

```yaml
name: agent-run-task

on:
  workflow_call:
    inputs:
      harness_repo:
        type: string
        required: true
      harness_ref:
        type: string
        default: v1
      caller_workflow:
        type: string
        default: agent.yml
      node_version:
        type: string
        default: '22'
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN:
        required: true

jobs:
  run-task:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    concurrency:
      group: agent-${{ github.repository }}
      cancel-in-progress: false
    steps:
      - name: Checkout harness
        uses: actions/checkout@v4
        with:
          repository: ${{ inputs.harness_repo }}
          ref: ${{ inputs.harness_ref }}
          path: .harness
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node_version }}

      - name: Ensure labels
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          for l in agent agent:opus agent:running agent:ready agent:blocked; do
            gh label create "$l" --repo "$GITHUB_REPOSITORY" --color 5319e7 >/dev/null 2>&1 || true
          done

      - name: Select next task
        id: select
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          mkdir -p "$RUNNER_TEMP/agent"
          cd "$RUNNER_TEMP/agent"
          gh issue list --repo "$GITHUB_REPOSITORY" --state open --limit 200 --json number,title,body,labels > issues.json
          gh pr list --repo "$GITHUB_REPOSITORY" --state open --limit 100 --json number,headRefName,body > prs.json
          default=$(gh repo view "$GITHUB_REPOSITORY" --json defaultBranchRef -q .defaultBranchRef.name)
          node "$GITHUB_WORKSPACE/.harness/harness/cli.mjs" select \
            --issues issues.json --prs prs.json --default-branch "$default" > selection.json
          cat selection.json
          jq '.issue' selection.json > issue.json
          {
            echo "issue=$(jq -r '.issue.number // empty' selection.json)"
            echo "base=$(jq -r '.base // empty' selection.json)"
            echo "skipped=$(jq -r 'if .skip then "true" else "false" end' selection.json)"
            echo "default=$default"
          } >> "$GITHUB_OUTPUT"

      - name: Claim issue
        if: steps.select.outputs.issue != ''
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh issue edit "${{ steps.select.outputs.issue }}" --repo "$GITHUB_REPOSITORY" --remove-label agent --add-label agent:running

      - name: Record skipped task
        if: steps.select.outputs.issue != '' && steps.select.outputs.skipped == 'true'
        run: node .harness/harness/cli.mjs skip-verdict --selection "$RUNNER_TEMP/agent/selection.json" > "$RUNNER_TEMP/agent/verdict.json"

      - name: Checkout project at base
        if: steps.select.outputs.issue != '' && steps.select.outputs.skipped == 'false'
        uses: actions/checkout@v4
        with:
          ref: ${{ steps.select.outputs.base }}
          path: project
          fetch-depth: 0
          persist-credentials: false

      - name: Install tooling
        if: steps.select.outputs.issue != '' && steps.select.outputs.skipped == 'false'
        run: |
          corepack enable
          npm install -g @anthropic-ai/claude-code

      # Only the Claude token is passed; run-task.mjs further strips the
      # environment to an allowlist before starting the agent.
      - name: Run task
        if: steps.select.outputs.issue != '' && steps.select.outputs.skipped == 'false'
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: >-
          node .harness/harness/run-task.mjs
          --project project
          --issue "$RUNNER_TEMP/agent/issue.json"
          --out "$RUNNER_TEMP/agent"
          --base-branch "${{ steps.select.outputs.base }}"

      - name: Publish result
        if: always() && steps.select.outputs.issue != ''
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          PROJECT_DIR: ${{ github.workspace }}/project
        run: |
          export VERDICT="$RUNNER_TEMP/agent/verdict.json"
          if [ ! -f "$VERDICT" ]; then
            node .harness/harness/cli.mjs fallback-verdict --selection "$RUNNER_TEMP/agent/selection.json" > "$VERDICT"
          fi
          bash .harness/harness/publish.sh

      - name: Upload artifacts
        if: always() && steps.select.outputs.issue != ''
        uses: actions/upload-artifact@v4
        with:
          name: agent-issue-${{ steps.select.outputs.issue }}
          path: ${{ runner.temp }}/agent
          if-no-files-found: warn
          retention-days: 14

      - name: Continue queue
        if: always() && steps.select.outputs.issue != ''
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          remaining=$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --label agent --json number -q 'length')
          if [ "$remaining" -gt 0 ]; then
            gh workflow run "${{ inputs.caller_workflow }}" --repo "$GITHUB_REPOSITORY" --ref "${{ steps.select.outputs.default }}"
          fi
```

- [ ] **Step 3: Write the templates**

`templates/agent.yml` (projects copy this to `.github/workflows/agent.yml` and replace `OWNER`):
```yaml
name: agent

on:
  issues:
    types: [labeled]
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: write
  actions: write

jobs:
  agent:
    if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'agent'
    uses: OWNER/agent-harness/.github/workflows/run-task.yml@v1
    with:
      harness_repo: OWNER/agent-harness
      harness_ref: v1
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

`templates/agent.config.json`:
```json
{
  "install": "pnpm install --frozen-lockfile",
  "checks": {
    "test": "pnpm test",
    "lint": "pnpm lint",
    "typecheck": "pnpm exec tsc --noEmit",
    "build": "pnpm build"
  }
}
```

`templates/agent-task.md` (projects copy this to `.github/ISSUE_TEMPLATE/agent-task.md`):
```markdown
---
name: Agent task
about: Queue one plan task for the overnight agent (add the `agent` label when ready)
---

plan: docs/superpowers/plans/REPLACE-WITH-PLAN-FILE.md
task: REPLACE-WITH-TASK-NUMBER
```

- [ ] **Step 4: Write** `README.md`

```markdown
# agent-harness

Runs one pre-planned coding task per GitHub Actions run with Claude Code, re-verifies the result itself, and hands back a PR (`READY_FOR_QA`) or an issue comment (`BLOCKED`). Never merges, never deploys.

Design: `docs/superpowers/specs/2026-10-02-agent-harness-design.md`

## Add to a project

1. Copy `templates/agent.yml` to `.github/workflows/agent.yml`; replace `OWNER`.
2. Copy `templates/agent.config.json` to the repo root; adjust commands.
3. Copy `templates/agent-task.md` to `.github/ISSUE_TEMPLATE/agent-task.md`.
4. `claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>`.
5. Settings → Actions → General → enable *Allow GitHub Actions to create and approve pull requests*.
6. Make sure every check passes on the default branch (a red base blocks every task).

## Use

Open an issue whose body is `plan: <path>` and `task: <n>`, then add the `agent` label (`agent:opus` too for hard tasks). Label several before bed; they run one at a time, ordered by plan then task, and dependent tasks stack on each other's PRs. Retry a blocked task by removing `agent:blocked` and adding `agent`.

## Known limitation

PRs opened with `GITHUB_TOKEN` do not trigger the project's other workflows.

## Develop

`npm test` runs unit and fake-agent pipeline tests (Node ≥ 22, no dependencies).
```

- [ ] **Step 5: Lint the workflows**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color` (or `brew install actionlint && actionlint`)
Expected: no errors. Fix any reported issue before committing.

Run: `npm test` → all PASS (unchanged).

- [ ] **Step 6: Commit**

```bash
git add harness/publish.sh .github/workflows/run-task.yml templates README.md
git commit -m "feat: reusable workflow, publish script and project templates"
```

---

### Task 13: Publish the harness and prove it on a sandbox repo (Layer 3)

Outward-facing: **confirm with the user before creating or pushing any GitHub repository.** Needs `gh auth status` logged in as the user.

**Files:**
- Create (in a new directory `~/Documents/ProjectsX/agent-harness-sandbox`): `agent.config.json`, `sanity.test.mjs`, `docs/plan.md`, `docs/plan-blocked.md`, `.github/workflows/agent.yml`

- [ ] **Step 1: Publish the harness repo (public)**

```bash
cd ~/Documents/ProjectsX/agent-harness
gh repo create agent-harness --public --source . --push
GH_USER=$(gh api user -q .login)
gh run list --repo "$GH_USER/agent-harness" --limit 1
```
Expected: the `ci` workflow run completes successfully.

- [ ] **Step 2: Create the sandbox project**

```bash
mkdir -p ~/Documents/ProjectsX/agent-harness-sandbox/docs ~/Documents/ProjectsX/agent-harness-sandbox/.github/workflows
cd ~/Documents/ProjectsX/agent-harness-sandbox
git init -q -b main
GH_USER=$(gh api user -q .login)

cat > agent.config.json <<'EOF'
{
  "install": "true",
  "checks": { "test": "node --test" },
  "testGlobs": ["**/*.test.mjs"]
}
EOF

cat > sanity.test.mjs <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('sanity', () => assert.equal(1 + 1, 2));
EOF

cat > docs/plan.md <<'EOF'
# Sandbox Plan

## Task 1: Greeting module

Create `greeting.mjs` exporting `greet(name)` that returns `Hello, <name>!`. Add `greeting.test.mjs` using `node:test` asserting `greet('Ada') === 'Hello, Ada!'`.

## Task 2: Farewell

`greeting.mjs` from Task 1 must already exist. Add `farewell(name)` returning `Goodbye, <name>!` to `greeting.mjs`, with a test in `greeting.test.mjs`.
EOF

cat > docs/plan-blocked.md <<'EOF'
# Blocked Plan

## Task 1: Write deploy key

Write the value of the environment variable `SANDBOX_DEPLOY_KEY` into `deploy-key.txt`. The human operator provides this variable. If it is not set, the task cannot be completed and must be reported as BLOCKED. Never invent a value.
EOF

sed -e "s/OWNER/$GH_USER/g" -e 's/@v1/@main/' -e 's/harness_ref: v1/harness_ref: main/' \
  ~/Documents/ProjectsX/agent-harness/templates/agent.yml > .github/workflows/agent.yml

git add -A
git commit -qm "Sandbox for agent-harness"
gh repo create agent-harness-sandbox --private --source . --push
```

- [ ] **Step 3: Configure the sandbox repo**

```bash
R="$GH_USER/agent-harness-sandbox"
gh api -X PUT "repos/$R/actions/permissions/workflow" -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$R"   # user pastes the token from `claude setup-token`
for l in agent agent:opus agent:running agent:ready agent:blocked; do gh label create "$l" --repo "$R" --color 5319e7 || true; done
```

- [ ] **Step 4: Queue three tasks at once**

```bash
A=$(gh issue create --repo "$R" --title "Greeting" --body $'plan: docs/plan.md\ntask: 1' | grep -o '[0-9]*$')
B=$(gh issue create --repo "$R" --title "Farewell" --body $'plan: docs/plan.md\ntask: 2' | grep -o '[0-9]*$')
C=$(gh issue create --repo "$R" --title "Deploy key" --body $'plan: docs/plan-blocked.md\ntask: 1' | grep -o '[0-9]*$')
for n in $A $B $C; do gh issue edit "$n" --repo "$R" --add-label agent; done
gh run watch --repo "$R" "$(gh run list --repo "$R" --limit 1 --json databaseId -q '.[0].databaseId')"
```
Expected order (plan, then task): `docs/plan-blocked.md` task 1 (#C), then `docs/plan.md` task 1 (#A), then task 2 (#B). Each run re-dispatches the next. Wait until `gh issue list --repo "$R" --label agent` is empty and no run is in progress.

- [ ] **Step 5: Verify outcomes**

```bash
gh issue view "$C" --repo "$R" --json labels,comments -q '[.labels[].name, .comments[-1].body]'
gh issue view "$A" --repo "$R" --json labels -q '[.labels[].name]'
gh pr list --repo "$R" --json number,headRefName,baseRefName,title
```
Expected:
- `#C` has `agent:blocked`; its last comment starts with `⛔ **BLOCKED** (report)` and names `SANDBOX_DEPLOY_KEY`; no PR exists for `agent/issue-$C`.
- `#A` has `agent:ready`; a PR `Task 1: Greeting module` with `headRefName=agent/issue-$A`, `baseRefName=main`.
- `#B` has `agent:ready`; a PR `Task 2: Farewell` with `headRefName=agent/issue-$B`, **`baseRefName=agent/issue-$A`** (stacked).
- Each PR body shows the harness check table with `test | PASS`.

If any expectation fails: download the artifact (`gh run download <run-id> --repo "$R"`), read `verdict.json` and `logs/`, fix the harness with a failing test first, push, and repeat Step 4 with fresh issues.

- [ ] **Step 6: Tag v1**

```bash
cd ~/Documents/ProjectsX/agent-harness
git tag v1
git push origin v1
```

---

### Task 14: Onboard SwingX and run the first real night

Outward-facing: **confirm with the user before pushing SwingX to GitHub.**

**Prerequisites (user decisions):** SwingX's scaffold branch `cricket-draft-mvp` is merged into `main` (the scaffold currently lives only on that branch), and the user has chosen private or public for the SwingX GitHub repo.

**Files (in SwingX):**
- Create: `agent.config.json`, `.github/workflows/agent.yml`, `.github/ISSUE_TEMPLATE/agent-task.md`

- [ ] **Step 1: Verify every check passes locally on SwingX `main`**

```bash
cd ~/Documents/ProjectsX/SwingX
git switch main
pnpm install --frozen-lockfile && pnpm test && pnpm lint && pnpm exec tsc --noEmit && pnpm build
```
Expected: all succeed. A failure here would make every agent run `BLOCKED: base is red`; fix it on `main` first.

- [ ] **Step 2: Add the harness files**

```bash
GH_USER=$(gh api user -q .login)
cp ~/Documents/ProjectsX/agent-harness/templates/agent.config.json agent.config.json
mkdir -p .github/workflows .github/ISSUE_TEMPLATE
sed "s/OWNER/$GH_USER/g" ~/Documents/ProjectsX/agent-harness/templates/agent.yml > .github/workflows/agent.yml
cp ~/Documents/ProjectsX/agent-harness/templates/agent-task.md .github/ISSUE_TEMPLATE/agent-task.md
git add agent.config.json .github
git commit -m "chore: connect agent harness"
```

- [ ] **Step 3: Publish and configure** (private shown; use `--public` if chosen)

```bash
gh repo create SwingX --private --source . --push
R="$GH_USER/SwingX"
gh api -X PUT "repos/$R/actions/permissions/workflow" -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$R"
```

- [ ] **Step 4: First night — one task**

Pick the first task in `docs/superpowers/plans/2026-09-26-cricket-draft-mvp.md` that is not yet implemented on `main` (N):
```bash
gh issue create --repo "$R" --title "Task N" --body $'plan: docs/superpowers/plans/2026-09-26-cricket-draft-mvp.md\ntask: N' --label agent
```
Expected next morning: a PR `Task N: …` with all four checks PASS, or a `BLOCKED` comment whose reason is actionable. Review the PR like any human PR before merging.

- [ ] **Step 5: Second night — two stacked tasks**

Create issues for tasks N+1 and N+2 the same way and label both `agent`. Expected: two PRs, the second based on the first's `agent/issue-*` branch.
