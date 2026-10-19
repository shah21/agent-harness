# Review Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Labelling an issue `review` with `pr:` lines reviews those existing pull requests read-only with the project's review skill and writes a brief review into the issue body.

**Architecture:** Pure helpers in `harness/lib/pr-review.mjs` (issue parsing, selection, harness-task lookup, checkout planning) and `harness/lib/pr-review-format.mjs` (rendering, issue-body merge). `harness/checkout-prs.sh` checks out each pull request head and records its merge base. `harness/lib/review-loop.mjs` exports its session and review-plus-verify step so `harness/review-run.mjs` reuses them. `harness/publish-review.sh` rewrites the issue body. A new reusable workflow ties select → run → publish together.

**Tech Stack:** Node ≥ 22, ES modules, `node:test`, bash, `jq`, GitHub Actions, `gh`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-review-runs-design.md`

**Execution:** Tasks 1–7 run as agent tasks (one issue each, label `agent`), in order. Task 8 adds a workflow under `.github/**` (protected) by hand. Task 9 is a manual dry run.

## Global Constraints

- No new dependencies. Existing tests are never edited; new cases go in new files. `test/compat.test.mjs` must pass after every task.
- **Compatibility:** task runs, review loops and debug runs keep their verdicts, prompts, comments and log names.
- **Generic:** nothing in `harness/`, `test/`, `templates/`, `docs/`, README or issue/PR text names a specific company, product, project or private repository. Fixtures: `o/r` (consumer), `o/super`, `o/sub`, `packages/core`.
- Commits: conventional messages, no trailers.
- Labels: `review` (queue), `agent:review-done` (done); existing `agent:running`, `agent:blocked`.
- Issue lines: `pr: owner/repo#123` or `pr: https://github.com/owner/repo/pull/123`, one per repository; optional `context: <path>`.
- Body marker, verbatim: `<!-- agent-pr-review -->`. Text above it is the request and is kept; text below is replaced on every run. Issue body cap: 60,000 characters.
- Size cap: 50,000 changed lines (additions + deletions over all pull requests).
- Verdict outcomes: `REVIEWED`, `BLOCKED`, `WAITING`. Review verdicts: `changes`, `comments`, `clean`.
- Reasons, verbatim: `bad issue: <error>`; `pull request not readable: <repo>#<n>`; `pull request has an unexpected head or base: <repo>#<n>`; `pull requests are too large to review here: <n> changed lines (limit 50000)`; `pull request is not in this repository or its target: <repo>#<n>`; `review runs need a "review" block with a "skill" in agent.config.json`; `pull request checkout failed`; `context file not found: <path>`; `invalid review: <error>`; `review timed out`.
- Files the workflow passes to the runner in its output directory: `selection.json`, `issue.json`, `checkout-plan.json`, `prs-checked.json` (written by `checkout-prs.sh`), `pr-checkout.txt` (only when checkout failed).
- Reviewer and verifier tools (review loop and review runs), verbatim: `Read,Glob,Grep,Write,Bash,Agent,Task`.

## Review Focus

- **A `pr:` line whose base branch name or head SHA could reach a shell unsafely.** Expected: skipped as `unexpected head or base` before any checkout. (Task 2 test `unsafe head or base is skipped`.)
- **A superproject pull request that moves a submodule pointer.** Expected: the submodule is checked out at the new pointer. (Task 3 test `a superproject head brings its submodule along`.)
- **The reviewer commits or edits on the detached head.** Expected: reverted to the pull request head; review still published. (Task 5 test `a reviewer that changes the checkout is reverted`.)
- **Re-running a review on an issue that already has one.** Expected: request kept, old review replaced, not appended. (Task 6 test `a second review replaces the first`.)
- **A huge review that would overflow the issue body.** Expected: folded details cut first; marker and verdict kept. (Task 6 test `an oversized review is cut to fit`.)

---

## Task 1: feat: review issues, selection and task lookup

**Files:**
- Create: `harness/lib/pr-review.mjs`
- Test: `test/pr-review.test.mjs`

**Interfaces:**
- Consumes: `parseTaskRef(body)` from `harness/lib/issue.mjs`; `parseTaskMarker(body)` from `harness/lib/queue.mjs`; `latestTargets(comments)` from `harness/lib/target.mjs`.
- Produces (exported from `harness/lib/pr-review.mjs`): `REVIEW_MARKER`; `requestText(body)` → string above the marker; `parseReviewIssue(body)` → `{ prs: { repo, number }[], context }` or `{ error }`; `selectReview({ issues })` → `{ issue: null }` or `{ issue, prs, context, skip }`; `planTaskFor({ pr, prBody, issues })` → `{ plan, task, issue }` or `null`.

- [ ] **Step 1: Write the failing tests** — create `test/pr-review.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_MARKER, requestText, parseReviewIssue, selectReview, planTaskFor } from '../harness/lib/pr-review.mjs';
import { taskMarker } from '../harness/lib/queue.mjs';
import { targetsMarker } from '../harness/lib/target.mjs';

test('the request is the text above the marker', () => {
  assert.equal(REVIEW_MARKER, '<!-- agent-pr-review -->');
  assert.equal(requestText(`pr: o/r#1\r\nplease look\n${REVIEW_MARKER}\n## old review`), 'pr: o/r#1\nplease look\n');
  assert.equal(requestText(null), '');
});

test('parses pr lines and an optional context line', () => {
  assert.deepEqual(parseReviewIssue('Check this\npr: o/super#12\npr: https://github.com/o/sub/pull/3\ncontext: docs/notes.md\n'), {
    prs: [{ repo: 'o/super', number: 12 }, { repo: 'o/sub', number: 3 }],
    context: 'docs/notes.md',
  });
  assert.deepEqual(parseReviewIssue(`pr: o/r#1\n${REVIEW_MARKER}\npr: o/other#9\n`), { prs: [{ repo: 'o/r', number: 1 }], context: null });
});

test('rejects bad issues', () => {
  assert.deepEqual(parseReviewIssue('no lines'), { error: 'issue body has no "pr: owner/repo#123" line' });
  assert.deepEqual(parseReviewIssue('pr: #12'), { error: 'pr must look like owner/repo#123 or a pull request URL: #12' });
  assert.deepEqual(parseReviewIssue('pr: o/r#1\npr: o/r#2'), { error: 'one pull request per repository: o/r' });
  assert.deepEqual(parseReviewIssue('pr: o/r#1\ncontext: ../x'), { error: 'context path must be relative inside the repository: ../x' });
});

test('selects the oldest queued review issue', () => {
  const issues = [
    { number: 9, title: 'b', body: 'pr: o/r#2', labels: [{ name: 'review' }] },
    { number: 4, title: 'a', body: 'pr: o/r#1', labels: [{ name: 'review' }, { name: 'agent:running' }] },
    { number: 6, title: 'c', body: 'pr: o/r#3', labels: ['review'] },
    { number: 2, title: 'd', body: 'pr: o/r#4', labels: ['debug'] },
  ];
  assert.deepEqual(selectReview({ issues }), {
    issue: { number: 6, title: 'c', body: 'pr: o/r#3', labels: ['review'] }, prs: [{ repo: 'o/r', number: 3 }], context: null, skip: null,
  });
  assert.deepEqual(selectReview({ issues: [] }), { issue: null });
  assert.equal(selectReview({ issues: [{ number: 1, title: 'x', body: 'nothing', labels: ['review'] }] }).skip,
    'bad issue: issue body has no "pr: owner/repo#123" line');
});

test('finds the harness task behind a pull request', () => {
  const own = planTaskFor({ pr: { repo: 'o/r', number: 5 }, prBody: `${taskMarker({ plan: 'docs/p.md', task: 3, issue: 41 })}\nCloses #41`, issues: [] });
  assert.deepEqual(own, { plan: 'docs/p.md', task: 3, issue: 41 });

  const ready = `✅ **READY_FOR_QA** — \`https://github.com/o/super/pull/12\`\n\n${targetsMarker([
    { repo: 'o/super', number: 12, branch: 'fix/x', base: 'main', role: 'super' },
  ])}`;
  const issues = [
    { number: 50, body: 'plan: docs/other.md\ntask: 1', comments: [{ body: 'unrelated' }] },
    { number: 51, body: 'plan: docs/q.md\ntask: 2', comments: [{ body: ready }] },
  ];
  assert.deepEqual(planTaskFor({ pr: { repo: 'o/super', number: 12 }, prBody: 'by hand', issues }), { plan: 'docs/q.md', task: 2, issue: 51 });
  assert.equal(planTaskFor({ pr: { repo: 'o/super', number: 13 }, prBody: '', issues }), null);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/pr-review.test.mjs`
Expected: FAIL (`Cannot find module '../harness/lib/pr-review.mjs'`).

- [ ] **Step 3: Implement** — create `harness/lib/pr-review.mjs`:

```js
// Pure helpers for review runs: the issue a person writes, which issue runs next, and the harness
// task behind a pull request.
import { parseTaskRef } from './issue.mjs';
import { parseTaskMarker } from './queue.mjs';
import { latestTargets } from './target.mjs';

export const REVIEW_MARKER = '<!-- agent-pr-review -->';
const PR_REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/;

const labelNames = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

// Only the text above the marker is the request; below it is the last review.
export const requestText = (body) => String(body ?? '').replace(/\r\n/g, '\n').split(REVIEW_MARKER)[0];

export function parseReviewIssue(body) {
  const text = requestText(body);
  const prs = [];
  for (const m of text.matchAll(/^pr:[ \t]*(\S+)[ \t]*$/gm)) {
    const hit = PR_REF.exec(m[1]) ?? PR_URL.exec(m[1]);
    if (!hit) return { error: `pr must look like owner/repo#123 or a pull request URL: ${m[1]}` };
    if (prs.some((p) => p.repo === hit[1])) return { error: `one pull request per repository: ${hit[1]}` };
    prs.push({ repo: hit[1], number: Number(hit[2]) });
  }
  if (!prs.length) return { error: 'issue body has no "pr: owner/repo#123" line' };
  const context = /^context:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1] ?? null;
  if (context && (context.startsWith('/') || context.split('/').includes('..'))) {
    return { error: `context path must be relative inside the repository: ${context}` };
  }
  return { prs, context };
}

export function selectReview({ issues }) {
  const next = issues
    .map((i) => ({ ...i, labels: labelNames(i.labels) }))
    .filter((i) => i.labels.includes('review') && !i.labels.includes('agent:running'))
    .sort((a, b) => a.number - b.number)[0];
  if (!next) return { issue: null };
  const issue = { number: next.number, title: next.title, body: next.body, labels: next.labels };
  const parsed = parseReviewIssue(next.body);
  return parsed.error
    ? { issue, prs: [], context: null, skip: `bad issue: ${parsed.error}` }
    : { issue, prs: parsed.prs, context: parsed.context, skip: null };
}

// The pull request's own task marker (same-repository pull requests), or the queue issue whose
// READY comment lists it (pull requests in a target repository).
export function planTaskFor({ pr, prBody, issues = [] }) {
  const own = parseTaskMarker(prBody);
  if (own) return own;
  for (const i of issues) {
    if (!latestTargets(i.comments)?.some((p) => p.repo === pr.repo && p.number === pr.number)) continue;
    const ref = parseTaskRef(i.body);
    if (!ref.error) return { plan: ref.plan, task: ref.task, issue: i.number };
  }
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/pr-review.test.mjs && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/lib/pr-review.mjs test/pr-review.test.mjs
git commit -m "feat: review issues, selection and task lookup"
```

---

## Task 2: feat: review selection and checkout planning commands

**Files:**
- Modify: `harness/lib/pr-review.mjs`
- Modify: `harness/cli.mjs`
- Test: `test/review-select.test.mjs`

**Interfaces:**
- Consumes: Task 1 helpers; `BRANCH_RE` and `parseGitmodules` from `harness/lib/target.mjs`; `loadConfig` from `harness/lib/config.mjs`.
- Produces:
  - `MAX_REVIEW_LINES` = `50000`; `buildReviewSelection({ selection, prData, candidates })` → selection with `prs: [{ repo, number, url, title, body, headSha, baseRef, lines }]`, `task`, `skip`.
  - `checkoutPlan({ selection, consumerRepo, target, submodules })` → `{ plan: [{ repo, number, dir, prefix, auth, headSha, baseRef }] }` (sorted outermost first) or `{ error }`.
  - CLI: `select-review --issues <f>`; `review-selection --selection <f> --prs <f> --candidates <f>`; `review-checkouts --config <f> --selection <f> --repo <owner/name> --project <dir> --out <dir>` (writes `checkout-plan.json`, or `pr-checkout.txt` with the reason); `review-skip-verdict --selection <f>`; `review-fallback-verdict --selection <f>`.

- [ ] **Step 1: Write the failing tests** — create `test/review-select.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildReviewSelection, checkoutPlan, MAX_REVIEW_LINES } from '../harness/lib/pr-review.mjs';

const CLI = new URL('../harness/cli.mjs', import.meta.url).pathname;
const SHA = 'a'.repeat(40);
const issue = { number: 7, title: 'Review', body: 'pr: o/super#12\npr: o/sub#3', labels: ['review'] };
const selection = { issue, prs: [{ repo: 'o/super', number: 12 }, { repo: 'o/sub', number: 3 }], context: null, skip: null };
const data = (extra = {}) => ({ url: 'https://github.com/o/super/pull/12', title: 'T', body: 'B', headRefOid: SHA, baseRefName: 'main', additions: 10, deletions: 5, ...extra });

test('builds the selection from pull request data', () => {
  const s = buildReviewSelection({ selection, prData: [data(), data({ url: 'u2', headRefOid: 'b'.repeat(40), additions: 1, deletions: 0 })], candidates: [] });
  assert.equal(s.skip, null);
  assert.equal(s.task, null);
  assert.deepEqual(s.prs[0], { repo: 'o/super', number: 12, url: 'https://github.com/o/super/pull/12', title: 'T', body: 'B', headSha: SHA, baseRef: 'main', lines: 15 });
  assert.equal(s.prs[1].headSha, 'b'.repeat(40));
});

test('unreadable, unsafe or oversized pull requests are skipped', () => {
  assert.equal(buildReviewSelection({ selection, prData: [data(), null] }).skip, 'pull request not readable: o/sub#3');
  assert.equal(buildReviewSelection({ selection, prData: [data({ headRefOid: 'main' }), data()] }).skip,
    'pull request has an unexpected head or base: o/super#12');
  assert.equal(buildReviewSelection({ selection, prData: [data({ baseRefName: '--upload-pack=x' }), data()] }).skip,
    'pull request has an unexpected head or base: o/super#12');
  assert.equal(buildReviewSelection({ selection, prData: [data({ additions: MAX_REVIEW_LINES }), data()] }).skip,
    'pull requests are too large to review here: 50020 changed lines (limit 50000)');
});

test('unsafe head or base is skipped', () => {
  assert.match(buildReviewSelection({ selection, prData: [data({ baseRefName: 'a..b' }), data()] }).skip, /unexpected head or base/);
});

test('a skipped selection passes through', () => {
  const skipped = { ...selection, skip: 'bad issue: x' };
  assert.equal(buildReviewSelection({ selection: skipped, prData: [] }), skipped);
});

test('checkout plan maps pull requests onto the consumer, target and submodules, outermost first', () => {
  const s = { prs: [{ repo: 'o/sub', number: 3, headSha: SHA, baseRef: 'main' }, { repo: 'o/super', number: 12, headSha: SHA, baseRef: 'dev' }] };
  const target = { repo: 'o/super', path: 'target' };
  assert.deepEqual(checkoutPlan({ selection: s, consumerRepo: 'o/r', target, submodules: [{ path: 'packages/core', repo: 'o/sub' }] }), {
    plan: [
      { repo: 'o/super', number: 12, dir: 'target', prefix: 'target/', auth: 'target', headSha: SHA, baseRef: 'dev' },
      { repo: 'o/sub', number: 3, dir: 'target/packages/core', prefix: 'target/packages/core/', auth: 'target', headSha: SHA, baseRef: 'main' },
    ],
  });
  assert.deepEqual(checkoutPlan({ selection: { prs: [{ repo: 'o/r', number: 1, headSha: SHA, baseRef: 'main' }] }, consumerRepo: 'o/r', target: null }).plan[0],
    { repo: 'o/r', number: 1, dir: '.', prefix: '', auth: 'consumer', headSha: SHA, baseRef: 'main' });
  assert.deepEqual(checkoutPlan({ selection: { prs: [{ repo: 'x/y', number: 1 }] }, consumerRepo: 'o/r', target }),
    { error: 'pull request is not in this repository or its target: x/y#1' });
});

test('cli commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-cli-'));
  const f = (name, obj) => { writeFileSync(join(dir, name), JSON.stringify(obj)); return join(dir, name); };
  const cli = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8' });

  const picked = JSON.parse(cli('select-review', '--issues', f('issues.json', [{ ...issue, labels: [{ name: 'review' }] }])));
  assert.deepEqual(picked.prs, selection.prs);

  const built = JSON.parse(cli('review-selection', '--selection', f('sel.json', selection), '--prs', f('prs.json', [data(), data()]), '--candidates', f('c.json', [])));
  assert.equal(built.prs.length, 2);

  const project = join(dir, 'project');
  mkdirSync(join(project, 'target'), { recursive: true });
  writeFileSync(join(project, 'target', '.gitmodules'), '[submodule "packages/core"]\n\tpath = packages/core\n\turl = https://github.com/o/sub.git\n');
  const config = f('config.json', { install: 'true', checks: { t: 'true' }, target: { repo: 'o/super', path: 'target' } });
  const out = join(dir, 'out');
  mkdirSync(out);
  cli('review-checkouts', '--config', config, '--selection', f('sel2.json', built), '--repo', 'o/r', '--project', project, '--out', out);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'checkout-plan.json'), 'utf8')).map((p) => p.dir), ['target', 'target/packages/core']);

  const out2 = join(dir, 'out2');
  mkdirSync(out2);
  cli('review-checkouts', '--config', config, '--selection', f('sel3.json', { prs: [{ repo: 'x/y', number: 1 }] }), '--repo', 'o/r', '--project', project, '--out', out2);
  assert.equal(readFileSync(join(out2, 'pr-checkout.txt'), 'utf8'), 'pull request is not in this repository or its target: x/y#1\n');
  assert.equal(existsSync(join(out2, 'checkout-plan.json')), false);

  const skipped = JSON.parse(cli('review-skip-verdict', '--selection', f('sk.json', { ...selection, skip: 'bad issue: x' })));
  assert.deepEqual([skipped.mode, skipped.outcome, skipped.kind, skipped.reasons], ['review', 'BLOCKED', 'gate', ['bad issue: x']]);
  const fallback = JSON.parse(cli('review-fallback-verdict', '--selection', join(dir, 'sel.json')));
  assert.deepEqual([fallback.outcome, fallback.kind], ['BLOCKED', 'harness']);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/review-select.test.mjs`
Expected: FAIL (`buildReviewSelection` is not exported).

- [ ] **Step 3: Implement the helpers** — in `harness/lib/pr-review.mjs`, change the `./target.mjs` import to `import { latestTargets, BRANCH_RE } from './target.mjs';` and add at the end:

```js
const SHA = /^[0-9a-f]{40}$/;
export const MAX_REVIEW_LINES = 50000;

// prData: one `gh pr view` result per requested pull request, in request order; null when unreadable.
// Head SHAs and base names reach shell steps, so both are checked here.
export function buildReviewSelection({ selection, prData, candidates = [] }) {
  if (!selection.issue || selection.skip) return selection;
  const prs = [];
  for (const [i, want] of selection.prs.entries()) {
    const d = prData[i];
    const name = `${want.repo}#${want.number}`;
    if (!d) return { ...selection, skip: `pull request not readable: ${name}` };
    const base = String(d.baseRefName ?? '');
    if (!SHA.test(String(d.headRefOid)) || !BRANCH_RE.test(base) || base.includes('..') || base.endsWith('.lock')) {
      return { ...selection, skip: `pull request has an unexpected head or base: ${name}` };
    }
    prs.push({
      ...want, url: d.url ?? null, title: d.title ?? '', body: d.body ?? '', headSha: d.headRefOid, baseRef: base,
      lines: (d.additions ?? 0) + (d.deletions ?? 0),
    });
  }
  const lines = prs.reduce((n, p) => n + p.lines, 0);
  if (lines > MAX_REVIEW_LINES) {
    return { ...selection, prs, skip: `pull requests are too large to review here: ${lines} changed lines (limit ${MAX_REVIEW_LINES})` };
  }
  const task = prs.map((p) => planTaskFor({ pr: p, prBody: p.body, issues: candidates })).find(Boolean) ?? null;
  return { ...selection, prs, task, skip: null };
}

// Where each pull request is checked out: the consumer root, the target clone, or one of its
// submodules. Outermost first, so a superproject's submodule update cannot undo a submodule checkout.
export function checkoutPlan({ selection, consumerRepo, target, submodules = [] }) {
  const places = [{ repo: consumerRepo, dir: '.', auth: 'consumer' }];
  if (target) {
    places.push({ repo: target.repo, dir: target.path, auth: 'target' });
    for (const s of submodules) places.push({ repo: s.repo, dir: `${target.path}/${s.path}`, auth: 'target' });
  }
  const plan = [];
  for (const pr of selection.prs) {
    const place = places.find((p) => p.repo.toLowerCase() === pr.repo.toLowerCase());
    if (!place) return { error: `pull request is not in this repository or its target: ${pr.repo}#${pr.number}` };
    plan.push({
      repo: pr.repo, number: pr.number, dir: place.dir, prefix: place.dir === '.' ? '' : `${place.dir}/`, auth: place.auth,
      headSha: pr.headSha, baseRef: pr.baseRef,
    });
  }
  const depth = (p) => (p.dir === '.' ? 0 : p.dir.split('/').length);
  return { plan: plan.sort((a, b) => depth(a) - depth(b)) };
}
```

- [ ] **Step 4: Add the CLI commands** — in `harness/cli.mjs`:
  - add `existsSync` to the `node:fs` import; add `import { selectReview, buildReviewSelection, checkoutPlan } from './lib/pr-review.mjs';` and `import { parseGitmodules } from './lib/target.mjs';`;
  - append to `USAGE`:

```
  cli.mjs select-review --issues <f>
  cli.mjs review-selection --selection <f> --prs <f> --candidates <f>
  cli.mjs review-checkouts --config <f> --selection <f> --repo <owner/name> --project <dir> --out <dir>
  cli.mjs review-skip-verdict --selection <f>
  cli.mjs review-fallback-verdict --selection <f>
```

  - add after `blockedDebugVerdict`:

```js
function blockedReviewVerdict(selection, kind, reason) {
  return {
    mode: 'review', outcome: 'BLOCKED', kind, reasons: [reason], warnings: [],
    issue: selection.issue.number, issueTitle: selection.issue.title, model: null, prs: [], task: null, review: null,
  };
}
```

  - in the `parseArgs` options add `candidates: { type: 'string' }, repo: { type: 'string' }, project: { type: 'string' }, body: { type: 'string' },` (keep the existing `prs` option);
  - add before the `render-debug-comment` case:

```js
  case 'select-review':
    print(selectReview({ issues: read(values.issues) }));
    break;
  case 'review-selection':
    print(buildReviewSelection({ selection: read(values.selection), prData: read(values.prs), candidates: read(values.candidates) }));
    break;
  case 'review-checkouts': {
    const config = loadConfig(readFileSync(values.config, 'utf8'));
    const modules = config.target ? join(values.project, config.target.path, '.gitmodules') : null;
    const submodules = modules && existsSync(modules) ? parseGitmodules(readFileSync(modules, 'utf8')) : [];
    const result = checkoutPlan({ selection: read(values.selection), consumerRepo: values.repo, target: config.target, submodules });
    if (result.error) writeFileSync(join(values.out, 'pr-checkout.txt'), `${result.error}\n`);
    else writeFileSync(join(values.out, 'checkout-plan.json'), `${JSON.stringify(result.plan, null, 2)}\n`);
    break;
  }
  case 'review-skip-verdict': {
    const selection = read(values.selection);
    print(blockedReviewVerdict(selection, 'gate', selection.skip));
    break;
  }
  case 'review-fallback-verdict':
    print(blockedReviewVerdict(read(values.selection), 'harness', 'the run ended without a verdict (crash or job timeout); see the run log'));
    break;
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/review-select.test.mjs && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add harness/lib/pr-review.mjs harness/cli.mjs test/review-select.test.mjs
git commit -m "feat: review selection and checkout planning commands"
```

---

## Task 3: feat: check out pull request heads

**Files:**
- Create: `harness/checkout-prs.sh`
- Test: `test/checkout-prs.test.mjs`

**Interfaces:**
- Consumes: `checkout-plan.json` entries (Task 2).
- Produces: `checkout-prs.sh` with env `PLAN` (plan file), `PROJECT` (project root), `OUT` (result file), optional `CONSUMER_TOKEN`, `TARGET_TOKEN`. Writes a JSON array: each plan entry plus `baseSha` (merge base of head and `origin/<baseRef>`). Exits non-zero on any failure.

- [ ] **Step 1: Write the failing tests** — create `test/checkout-prs.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeTargetProject } from './helpers/target-fixture.mjs';

const SCRIPT = new URL('../harness/checkout-prs.sh', import.meta.url).pathname;
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function run(plan, project, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'checkout-prs-'));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8', env: { ...process.env, ...env, PLAN: join(dir, 'plan.json'), PROJECT: project, OUT: join(dir, 'out.json') },
  });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) : null };
}

// A consumer clone whose remote has main plus a pull request branch that forked from main.
function consumer() {
  const root = mkdtempSync(join(tmpdir(), 'checkout-prs-remote-'));
  const remote = join(root, 'r.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const work = join(root, 'work');
  execFileSync('git', ['clone', '-q', remote, work]);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(work, 'a.txt'), 'b\n');
  git(work, 'commit', '-qam', 'change');
  git(work, 'push', '-q', 'origin', 'feature');
  const head = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', 'main');
  writeFileSync(join(work, 'm.txt'), 'later\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'main moves on');
  git(work, 'push', '-q', 'origin', 'main');
  const project = join(root, 'project');
  execFileSync('git', ['clone', '-q', remote, project]);
  return { project, base, head };
}

test('checks out the head detached and records the merge base', () => {
  const { project, base, head } = consumer();
  const entry = { repo: 'o/r', number: 5, dir: '.', prefix: '', auth: 'consumer', headSha: head, baseRef: 'main' };
  const { status, stderr, out } = run([entry], project);
  assert.equal(status, 0, stderr);
  assert.deepEqual(out, [{ ...entry, baseSha: base }]);
  assert.equal(git(project, 'rev-parse', 'HEAD'), head);
  assert.equal(git(project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
});

test('an unknown head fails', () => {
  const { project } = consumer();
  const { status } = run([{ repo: 'o/r', number: 5, dir: '.', prefix: '', auth: 'consumer', headSha: 'f'.repeat(40), baseRef: 'main' }], project);
  assert.notEqual(status, 0);
});

test('a superproject head brings its submodule along', () => {
  const { projectDir, remotes } = makeTargetProject();
  const scratch = mkdtempSync(join(tmpdir(), 'checkout-prs-super-'));
  const subWork = join(scratch, 'sub');
  execFileSync('git', ['clone', '-q', remotes.sub, subWork]);
  writeFileSync(join(subWork, 'lib.txt'), 'pr\n');
  git(subWork, 'commit', '-qam', 'sub change');
  git(subWork, 'push', '-q', 'origin', 'HEAD:refs/heads/pr');
  const subHead = git(subWork, 'rev-parse', 'HEAD');
  const supWork = join(scratch, 'super');
  execFileSync('git', ['clone', '-q', '--recurse-submodules', remotes.super, supWork], { env: { ...process.env, ...remotes.gitEnv }, stdio: 'ignore' });
  execFileSync('git', ['fetch', '-q', 'origin', 'pr'], { cwd: join(supWork, 'packages', 'core'), env: { ...process.env, ...remotes.gitEnv }, stdio: 'ignore' });
  git(join(supWork, 'packages', 'core'), 'checkout', '-q', subHead);
  git(supWork, 'checkout', '-q', '-b', 'pr');
  git(supWork, 'add', 'packages/core');
  git(supWork, 'commit', '-qm', 'point at the sub change');
  git(supWork, 'push', '-q', 'origin', 'pr');
  const supHead = git(supWork, 'rev-parse', 'HEAD');

  const entry = { repo: 'o/super', number: 12, dir: 'target', prefix: 'target/', auth: 'target', headSha: supHead, baseRef: 'main' };
  const { status, stderr } = run([entry], projectDir, remotes.gitEnv);
  assert.equal(status, 0, stderr);
  assert.equal(git(join(projectDir, 'target'), 'rev-parse', 'HEAD'), supHead);
  assert.equal(git(join(projectDir, 'target', 'packages', 'core'), 'rev-parse', 'HEAD'), subHead);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/checkout-prs.test.mjs`
Expected: FAIL (script missing).

- [ ] **Step 3: Implement** — create `harness/checkout-prs.sh`:

```bash
#!/usr/bin/env bash
# Checks out each pull request's head (detached) in its repository and records the merge base with
# its base branch. Tokens authenticate these fetches only; nothing is written to disk.
set -euo pipefail
: "${PLAN:?}" "${PROJECT:?}" "${OUT:?}"

result='[]'
count=$(jq length "$PLAN")
for ((i = 0; i < count; i++)); do
  entry=$(jq -c ".[$i]" "$PLAN")
  dir="$PROJECT/$(jq -r .dir <<<"$entry")"
  head=$(jq -r .headSha <<<"$entry")
  base=$(jq -r .baseRef <<<"$entry")
  token=""
  case "$(jq -r .auth <<<"$entry")" in
    consumer) token="${CONSUMER_TOKEN:-}" ;;
    target) token="${TARGET_TOKEN:-}" ;;
  esac
  args=()
  if [ -n "$token" ]; then
    args=(-c "http.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')")
  fi
  git -C "$dir" ${args[@]+"${args[@]}"} fetch -q origin "$head" "+refs/heads/$base:refs/remotes/origin/$base"
  git -C "$dir" checkout -q --detach "$head"
  if [ -f "$dir/.gitmodules" ]; then
    git -C "$dir" ${args[@]+"${args[@]}"} submodule update -q --init --recursive
  fi
  merge_base=$(git -C "$dir" merge-base "$head" "origin/$base")
  result=$(jq -c --argjson e "$entry" --arg mb "$merge_base" '. + [$e + {baseSha: $mb}]' <<<"$result")
done
printf '%s\n' "$result" > "$OUT"
```

Make it executable: `chmod +x harness/checkout-prs.sh`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/checkout-prs.test.mjs && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/checkout-prs.sh test/checkout-prs.test.mjs
git commit -m "feat: check out pull request heads"
```

---

## Task 4: refactor: share the review step

`runReviewLoop` keeps its behaviour; its account-rotating session and its review-plus-verify step become exports, and the reviewer may start subagents.

**Files:**
- Modify: `harness/lib/review-loop.mjs`
- Test: `test/review-step.test.mjs`

**Interfaces:**
- Produces (exported from `harness/lib/review-loop.mjs`):
  - `REVIEW_TOOLS` = `'Read,Glob,Grep,Write,Bash,Agent,Task'`
  - `reviewTemplates()` → `{ review, verify, fix }` prompt texts
  - `createSession({ envConfig, accounts, env, projectDir, outDir, logsDir, maxTurns, remainingSec })` → `async ({ name, round, model, tools, promptText, outputPath, override, onLimit }) => { limited } | { timedOut, text }`
  - `reviewStep({ n, repos, session, model, templates, input: { goal, skillDir, planTask, rules, history }, env, outDir, warnings })` → `{ limited } | { timedOut } | { error } | { findings }`
  - `runReviewLoop(...)` unchanged signature and results.

- [ ] **Step 1: Write the failing test** — create `test/review-step.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REVIEW_TOOLS, reviewTemplates, createSession, reviewStep } from '../harness/lib/review-loop.mjs';

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), 'fake-agents');
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

test('reviewers may start subagents', () => {
  assert.equal(REVIEW_TOOLS, 'Read,Glob,Grep,Write,Bash,Agent,Task');
});

test('one review step reviews, verifies and returns findings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-step-'));
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'base.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'greeting.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'greeting');
  const outDir = mkdtempSync(join(tmpdir(), 'review-step-out-'));
  const logsDir = join(outDir, 'logs');
  mkdirSync(logsDir);
  const env = {
    ...process.env, AGENT_REVIEW_CMD: `sh "${join(AGENTS, 'review-once.sh')}"`, AGENT_VERIFY_CMD: `sh "${join(AGENTS, 'verify-withdraw.sh')}"`,
  };
  const session = createSession({
    envConfig: {}, accounts: [{ token: undefined, account: null }], env, projectDir: dir, outDir, logsDir, maxTurns: 5, remainingSec: () => 60,
  });
  const warnings = [];
  const step = await reviewStep({
    n: 1, repos: [{ prefix: '', dir, base, branch: 'main' }], session, model: 'opus', templates: reviewTemplates(),
    input: { goal: '', skillDir: join(outDir, 'review-skill'), planTask: '## Task 1: x', rules: [], history: '(first review)' }, env, outDir, warnings,
  });
  assert.deepEqual(warnings, []);
  assert.equal(step.findings[0].verification, 'WITHDRAWN');
  assert.equal(step.findings[1].severity, 'low');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/review-step.test.mjs`
Expected: FAIL (`REVIEW_TOOLS` is not exported).

- [ ] **Step 3: Refactor** — replace `harness/lib/review-loop.mjs` with:

```js
// Review → fix → verify rounds after a READY task, plus the review step review runs share. The
// outcome stays READY_FOR_QA whatever happens here; every repository always ends on the last state
// whose checks passed.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runWithTimeout } from './run-cmd.mjs';
import { agentCommand, agentEnv, detectUsageLimit } from './agent.mjs';
import { snapshot, enforceReadOnly } from './debug-guard.mjs';
import {
  parseReviewOutput, parseFixReplies, withoutCommit, nextStep, actionable, openFindings, fitsBudget, parseVerifyReplies, applyVerification,
} from './review.mjs';
import {
  readRules, nearestContext, changedPaths, changedHunks, diffText, planTaskSection, planGoal, historyText, copySkill,
  renderReviewPrompt, renderFixPrompt, renderVerifyPrompt,
} from './review-inputs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Reviewer and verifier may run commands and start subagents (a review skill's large-change tier) to
// probe the change; read-only is enforced by snapshot and revert. Claude Code has named the subagent
// tool both Agent and Task.
export const REVIEW_TOOLS = 'Read,Glob,Grep,Write,Bash,Agent,Task';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const key = (r) => r.prefix || '.';
const heads = (repos) => Object.fromEntries(repos.map((r) => [key(r), git(r.dir, 'rev-parse', 'HEAD')]));
const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

function resetTo(repos, shas) {
  for (const r of repos) {
    git(r.dir, 'checkout', '-q', '-f', r.branch);
    git(r.dir, 'reset', '-q', '--hard', shas[key(r)]);
    git(r.dir, 'clean', '-fdq');
  }
}

export const reviewTemplates = () => ({
  review: readFileSync(join(HERE, '..', 'review-prompt.md'), 'utf8'),
  verify: readFileSync(join(HERE, '..', 'verify-prompt.md'), 'utf8'),
  fix: readFileSync(join(HERE, '..', 'fix-prompt.md'), 'utf8'),
});

// One agent session, tried on each account in turn while the account is out of usage.
export function createSession({ envConfig, accounts, env, projectDir, outDir, logsDir, maxTurns, remainingSec }) {
  return async ({ name, round, model, tools, promptText, outputPath, override, onLimit }) => {
    writeFileSync(join(outDir, `${name}.prompt.md`), promptText);
    for (const [i, attempt] of accounts.entries()) {
      rmSync(outputPath, { force: true });
      const logFile = join(logsDir, i === 0 ? `${name}.log` : `${name}-${i + 1}.log`);
      const extra = { ...envConfig, AGENT_OUTPUT_PATH: outputPath, AGENT_REVIEW_ROUND: String(round) };
      if (attempt.token) extra.CLAUDE_CODE_OAUTH_TOKEN = attempt.token;
      const r = await runWithTimeout(
        agentCommand({ model, maxTurns, promptText, addDir: outDir, override, tools }),
        { cwd: projectDir, timeoutSec: Math.max(1, Math.floor(remainingSec())), logFile, env: agentEnv(env, extra) },
      );
      if (r.exitCode === 0 || !detectUsageLimit(readFileSync(logFile, 'utf8'))) {
        return { timedOut: r.timedOut, text: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null };
      }
      onLimit?.();
    }
    return { limited: true };
  };
}

// One review and its verify pass: a fresh session tries to refute each high and medium finding.
export async function reviewStep({ n, repos, session, model, templates, input, env, outDir, warnings }) {
  const paths = changedPaths(repos);
  const reviewPath = join(outDir, `review-${n}.md`);
  const snaps = snapshot(repos.map((r) => r.dir));
  const review = await session({
    name: `review-${n}`, round: n, model, tools: REVIEW_TOOLS, outputPath: reviewPath, override: env.AGENT_REVIEW_CMD,
    promptText: renderReviewPrompt(templates.review, {
      round: n, goal: input.goal, skillDir: input.skillDir, planTask: input.planTask, diff: diffText(repos),
      rules: input.rules, contexts: nearestContext(repos, paths), history: input.history, outputPath: reviewPath,
    }),
  });
  if (enforceReadOnly(snaps).length) warnings.push(`review round ${n}: the reviewer changed the checkout; changes were discarded`);
  if (review.limited) return { limited: true };
  if (review.timedOut) return { timedOut: true };
  const parsed = parseReviewOutput(review.text, paths, changedHunks(repos));
  if (!parsed.ok) return { error: parsed.error };

  let findings = parsed.findings;
  const toCheck = findings.filter((f) => f.severity !== 'low');
  if (toCheck.length) {
    const verifyPath = join(outDir, `verify-${n}.md`);
    const verifySnaps = snapshot(repos.map((r) => r.dir));
    const check = await session({
      name: `verify-${n}`, round: n, model, tools: REVIEW_TOOLS, outputPath: verifyPath, override: env.AGENT_VERIFY_CMD,
      promptText: renderVerifyPrompt(templates.verify, {
        round: n, skillDir: input.skillDir, planTask: input.planTask, diff: diffText(repos), findings: toCheck, outputPath: verifyPath,
      }),
    });
    if (enforceReadOnly(verifySnaps).length) warnings.push(`review round ${n}: the verifier changed the checkout; changes were discarded`);
    const failed = check.limited || check.timedOut || check.text === null;
    if (failed) warnings.push(`review round ${n}: verification failed; all findings kept`);
    findings = applyVerification(findings, parseVerifyReplies(failed ? null : check.text, toCheck.map((f) => f.id)));
  }
  return { findings };
}

export async function runReviewLoop({
  config, repos, planText, task, implementerModel, accounts, env, projectDir, outDir, logsDir, verify, gateReasons, promptSuffix = '',
}) {
  const rc = config.review;
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  const rounds = [];
  const warnings = [];
  let green = heads(repos);
  let finalChecks = null;
  let longest = 0;
  let exit = null;
  let error = null;

  const templates = reviewTemplates();
  const goal = planGoal(planText);
  const skillDir = join(outDir, 'review-skill');
  const planTask = planTaskSection(planText, task);
  const session = createSession({
    envConfig: config.env, accounts, env, projectDir, outDir, logsDir, maxTurns: rc.maxTurns, remainingSec: () => rc.timeout - elapsed(),
  });

  try {
    const rules = readRules(repos, rc.rules);
    const skill = copySkill(repos, rc.skill, skillDir);
    if (skill.error) {
      exit = 'reviewer-error';
      error = skill.error;
    }
    for (let n = 1; !exit; n++) {
      if (n > 1 && !fitsBudget({ elapsedSec: elapsed(), budgetSec: rc.timeout, longestStepSec: longest })) { exit = 'budget'; break; }
      const reviewStart = Date.now();
      const step = await reviewStep({
        n, repos, session, model: rc.model, templates, input: { goal, skillDir, planTask, rules, history: historyText(rounds) }, env, outDir, warnings,
      });
      if (step.limited) { exit = 'usage-limit'; break; }
      if (step.timedOut) { exit = 'budget'; break; }
      if (step.error) { exit = 'reviewer-error'; error = step.error; break; }
      const { findings } = step;

      const round = { n, findings };
      rounds.push(round);
      longest = Math.max(longest, (Date.now() - reviewStart) / 1000);
      const next = nextStep({ round: n, maxRounds: rc.maxRounds, findings, previous: rounds.at(-2)?.findings ?? null });
      if (next !== 'fix') { exit = next; round.durationSec = Math.round((Date.now() - reviewStart) / 1000); break; }
      if (!fitsBudget({ elapsedSec: elapsed(), budgetSec: rc.timeout, longestStepSec: longest })) { exit = 'budget'; break; }

      const fixStart = Date.now();
      const toFix = actionable(findings);
      const ids = toFix.map((f) => f.id);
      const fixPath = join(outDir, `fix-${n}.md`);
      const fix = await session({
        name: `fix-${n}`, round: n, model: implementerModel, outputPath: fixPath, override: env.AGENT_FIX_CMD,
        onLimit: () => resetTo(repos, green),
        promptText: renderFixPrompt(templates.fix, {
          round: n, branch: repos[0].branch, planTask, diff: diffText(repos), findings: toFix, outputPath: fixPath,
          checks: config.checks, protectedPaths: config.protectedPaths, hasSetup: Boolean(config.setup),
        }) + promptSuffix,
      });
      if (fix.limited) { resetTo(repos, green); exit = 'usage-limit'; break; }
      round.fixes = parseFixReplies(fix.text, ids);
      if (fix.timedOut) { resetTo(repos, green); round.reverted = true; exit = 'budget'; break; }

      const off = repos.find((r) => git(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD') !== r.branch);
      if (off) {
        resetTo(repos, green);
        round.reverted = true;
        exit = 'gate';
        error = `fixer switched ${off.prefix ? off.prefix.slice(0, -1) : 'the repository'} off ${off.branch}`;
        break;
      }
      for (const r of repos) {
        if (git(r.dir, 'status', '--porcelain', '--ignore-submodules=all')) {
          git(r.dir, 'stash', 'push', '--include-untracked', '-q', '-m', 'agent-harness: uncommitted review fix changes');
          warnings.push(`review round ${n}: the fixer left uncommitted changes; they were stashed`);
        }
      }

      const after = heads(repos);
      round.reverted = false;
      if (same(after, green)) {
        round.fixes = withoutCommit(round.fixes);
        round.commit = null;
        round.durationSec = Math.round((Date.now() - reviewStart) / 1000);
        longest = Math.max(longest, (Date.now() - fixStart) / 1000);
        continue;
      }
      round.commit = after['.'] !== green['.'] ? after['.'] : null;
      const moved = repos.filter((r) => r.prefix && after[key(r)] !== green[key(r)]);
      if (moved.length) round.targets = Object.fromEntries(moved.map((r) => [r.prefix.slice(0, -1), after[key(r)]]));

      const violations = gateReasons();
      if (violations.length) { resetTo(repos, green); round.reverted = true; exit = 'gate'; error = violations.join('; '); break; }
      const verified = await verify(`review-${n}`);
      round.checks = verified.checks ?? {};
      if (verified.error || !Object.values(verified.checks).every((c) => c.ok)) {
        resetTo(repos, green);
        round.reverted = true;
        exit = 'fix-broke-checks';
        error = verified.error ?? null;
        break;
      }
      green = after;
      finalChecks = verified.checks;
      round.durationSec = Math.round((Date.now() - reviewStart) / 1000);
      longest = Math.max(longest, (Date.now() - fixStart) / 1000);
    }
  } catch (e) {
    try {
      resetTo(repos, green);
    } catch {
      // repository unreadable; the run's own crash handling takes over
    }
    exit = 'reviewer-error';
    error = String(e.message).split('\n')[0];
  }
  return {
    review: { model: rc.model, exit, rounds, open: openFindings(rounds), ...(error ? { error } : {}) },
    finalChecks,
    warnings,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/review-step.test.mjs && npm test`
Expected: all PASS, including every existing `test/review*.test.mjs` and `test/trailers.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add harness/lib/review-loop.mjs test/review-step.test.mjs
git commit -m "refactor: share the review step"
```

---

## Task 5: feat: review runner

**Files:**
- Create: `harness/review-run.mjs`
- Test: `test/review-run.test.mjs`

**Interfaces:**
- Consumes: `createSession`, `reviewStep`, `reviewTemplates` (Task 4); `copySkill`, `readRules`, `planGoal`, `planTaskSection` from `harness/lib/review-inputs.mjs`; `actionable` from `harness/lib/review.mjs`; `snapshot`, `enforceReadOnly`; `probeAccounts`; `loadConfig`.
- Produces: `runReview({ projectDir, issue, outDir, configPath, selection, defaultBranch, env })` → verdict (spec §6), written to `<outDir>/verdict.json`. CLI: `node harness/review-run.mjs --project <dir> --issue <f> --out <dir> --selection <f> --default-branch <b> [--config <f>]`.

- [ ] **Step 1: Write the failing tests** — create `test/review-run.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runReview } from '../harness/review-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, 'fake-agents');
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const ISSUE = { number: 30, title: 'Review greeting', body: 'pr: o/r#5', labels: ['review'] };
const REVIEW = { skill: 'skill', maxRounds: 1, timeout: '2m', maxTurns: 5 };

// The consumer at a pull request head: main plus a feature commit adding greeting.txt, checked out detached.
function project(review = REVIEW) {
  const dir = mkdtempSync(join(tmpdir(), 'review-run-'));
  cpSync(join(HERE, 'fixtures', 'project'), dir, { recursive: true });
  mkdirSync(join(dir, 'skill'), { recursive: true });
  writeFileSync(join(dir, 'skill', 'SKILL.md'), '# Fixture review skill\n');
  const path = join(dir, 'agent.config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (review) config.review = review;
  writeFileSync(path, JSON.stringify(config, null, 2));
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'greeting.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'Add greeting');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', head);
  return { dir, base, head, git };
}

async function run({ reviewer = 'review-once.sh', verifier = 'verify-confirm.sh', review = REVIEW, task = null, checked = true, headOverride } = {}) {
  const p = project(review);
  const outDir = mkdtempSync(join(tmpdir(), 'review-run-out-'));
  const pr = { repo: 'o/r', number: 5, url: 'https://github.com/o/r/pull/5', title: 'Add greeting', body: 'Adds a greeting.', headSha: p.head, baseRef: 'main', lines: 1 };
  const selection = { issue: ISSUE, prs: [pr], context: null, task, skip: null };
  if (checked) {
    writeFileSync(join(outDir, 'prs-checked.json'), JSON.stringify([
      { repo: 'o/r', number: 5, dir: '.', prefix: '', auth: 'consumer', headSha: headOverride ?? p.head, baseRef: 'main', baseSha: p.base },
    ]));
  }
  const sh = (name) => `sh "${join(AGENTS, name)}"`;
  const env = { ...process.env, AGENT_CMD: 'true', AGENT_REVIEW_CMD: sh(reviewer), AGENT_VERIFY_CMD: sh(verifier) };
  const verdict = await runReview({ projectDir: p.dir, issue: ISSUE, outDir, selection, defaultBranch: 'main', env });
  return { verdict, outDir, ...p };
}

test('reviews a pull request', async () => {
  const { verdict, head, git, outDir } = await run();
  assert.equal(verdict.mode, 'review');
  assert.equal(verdict.outcome, 'REVIEWED', JSON.stringify(verdict.reasons));
  assert.equal(verdict.review.verdict, 'changes');
  assert.equal(verdict.review.findings[0].verification, 'CONFIRMED');
  assert.deepEqual(verdict.prs, [{ repo: 'o/r', number: 5, url: 'https://github.com/o/r/pull/5', headSha: head, baseSha: verdict.prs[0].baseSha, prefix: '' }]);
  assert.equal(git('rev-parse', 'HEAD'), head);
  const prompt = readFileSync(join(outDir, 'review-1.prompt.md'), 'utf8');
  assert.match(prompt, /### o\/r#5: Add greeting\n\nAdds a greeting\./);
  assert.match(prompt, /no plan task found/);
  assert.ok(existsSync(join(outDir, 'review-skill', 'SKILL.md')));
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'verdict.json'), 'utf8')).outcome, 'REVIEWED');
});

test('a clean review and a withdrawn finding both look good', async () => {
  assert.equal((await run({ reviewer: 'review-clean.sh' })).verdict.review.verdict, 'clean');
  assert.equal((await run({ reviewer: 'review-stubborn.sh', verifier: 'verify-withdraw.sh' })).verdict.review.verdict, 'clean');
});

test('the plan task reaches the prompt when the pull request came from a harness task', async () => {
  const { outDir } = await run({ task: { plan: 'docs/plan.md', task: 1, issue: 7 } });
  assert.match(readFileSync(join(outDir, 'review-1.prompt.md'), 'utf8'), /## Task 1: Add greeting/);
});

test('blocked runs', async () => {
  assert.deepEqual((await run({ review: null })).verdict.reasons, ['review runs need a "review" block with a "skill" in agent.config.json']);
  const missing = await run({ checked: false });
  assert.deepEqual([missing.verdict.kind, missing.verdict.reasons], ['harness', ['pull request checkout failed']]);
  const moved = await run({ headOverride: 'f'.repeat(40) });
  assert.deepEqual(moved.verdict.reasons, ['pull request checkout failed']);
  const noSkill = await run({ review: { ...REVIEW, skill: 'nope' } });
  assert.deepEqual([noSkill.verdict.kind, noSkill.verdict.reasons], ['agent', ['review skill not found: nope/SKILL.md']]);
  const bad = await run({ reviewer: 'review-bad.sh' });
  assert.equal(bad.verdict.kind, 'agent');
  assert.match(bad.verdict.reasons[0], /^invalid review: no ```json block/);
});

test('a usage limit waits', async () => {
  const { verdict } = await run({ reviewer: 'review-limited.sh' });
  assert.equal(verdict.outcome, 'WAITING');
});

test('a reviewer that changes the checkout is reverted', async () => {
  const { verdict, head, git, dir } = await run({ reviewer: 'review-editor.sh' });
  assert.equal(verdict.outcome, 'REVIEWED');
  assert.ok(verdict.warnings.includes('review round 1: the reviewer changed the checkout; changes were discarded'));
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(dir, 'greeting.txt'), 'utf8'), 'hello\n');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/review-run.test.mjs`
Expected: FAIL (`Cannot find module '../harness/review-run.mjs'`).

- [ ] **Step 3: Implement** — create `harness/review-run.mjs`:

```js
#!/usr/bin/env node
// Reviews existing pull requests read-only and writes verdict.json. Network-free: selection,
// checkouts and publishing happen in the workflow around it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './lib/config.mjs';
import { runWithTimeout } from './lib/run-cmd.mjs';
import { agentEnv, claudeTokens } from './lib/agent.mjs';
import { probeAccounts } from './lib/probe.mjs';
import { snapshot, enforceReadOnly } from './lib/debug-guard.mjs';
import { actionable } from './lib/review.mjs';
import { copySkill, readRules, planGoal, planTaskSection } from './lib/review-inputs.mjs';
import { createSession, reviewStep, reviewTemplates } from './lib/review-loop.mjs';

const MAX_CONTEXT_CHARS = 100000;
const blocked = (kind, reason, extra = {}) => ({ outcome: 'BLOCKED', kind, reasons: [reason], ...extra });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

export async function runReview({ projectDir, issue, outDir, configPath, selection, defaultBranch, env = process.env }) {
  projectDir = resolve(projectDir);
  outDir = resolve(outDir);
  const logsDir = join(outDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const verdictPath = join(outDir, 'verdict.json');
  rmSync(verdictPath, { force: true });

  const meta = { mode: 'review', issue: issue.number, issueTitle: issue.title, model: null, account: null, prs: [], task: selection?.task ?? null, review: null };
  const finish = (result) => {
    const verdict = { kind: null, reasons: [], warnings: [], ...meta, ...result };
    writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));
    return verdict;
  };
  const state = { snaps: null };
  try {
    return await execute({ projectDir, outDir, logsDir, configPath, selection, defaultBranch, env, meta, finish, state });
  } catch (e) {
    try {
      if (state.snaps) enforceReadOnly(state.snaps);
    } catch {
      // repository unreadable
    }
    return finish(blocked('harness', `harness error: ${String(e.message).split('\n')[0]}`));
  }
}

async function execute({ projectDir, outDir, logsDir, configPath: configOverride, selection, defaultBranch, env, meta, finish, state }) {
  const configPath = configOverride ?? join(projectDir, 'agent.config.json');
  if (!existsSync(configPath)) return finish(blocked('harness', 'agent.config.json not found in project root'));
  let config;
  try {
    config = loadConfig(readFileSync(configPath, 'utf8'));
  } catch (e) {
    return finish(blocked('harness', `invalid agent.config.json: ${e.message}`));
  }
  if (!config.review) return finish(blocked('gate', 'review runs need a "review" block with a "skill" in agent.config.json'));
  const rc = config.review;
  meta.model = rc.model;
  const quietEnv = { ...agentEnv(env, {}), ...config.env };
  delete quietEnv.CLAUDE_CODE_OAUTH_TOKEN;

  // Checkouts made by the workflow (checkout-prs.sh): every repository must sit at its pull request head.
  const checkedPath = join(outDir, 'prs-checked.json');
  if (existsSync(join(outDir, 'pr-checkout.txt')) || !existsSync(checkedPath)) return finish(blocked('harness', 'pull request checkout failed'));
  const checked = JSON.parse(readFileSync(checkedPath, 'utf8'));
  if (!checked.length || checked.some((c) => tryGit(join(projectDir, c.dir), 'rev-parse', 'HEAD') !== c.headSha)) {
    return finish(blocked('harness', 'pull request checkout failed'));
  }
  const info = new Map(selection.prs.map((p) => [`${p.repo}#${p.number}`, p]));
  meta.prs = checked.map((c) => ({
    repo: c.repo, number: c.number, url: info.get(`${c.repo}#${c.number}`)?.url ?? null, headSha: c.headSha, baseSha: c.baseSha, prefix: c.prefix,
  }));
  const repos = checked.map((c) => ({ prefix: c.prefix, dir: join(projectDir, c.dir), base: c.baseSha, branch: 'HEAD' }));

  // The skill and rules may live in a repository no pull request touches: read those at their current commit.
  const known = [...repos];
  const addKnown = (prefix, dir) => {
    if (!known.some((r) => r.prefix === prefix) && existsSync(join(dir, '.git'))) known.push({ prefix, dir, base: git(dir, 'rev-parse', 'HEAD'), branch: 'HEAD' });
  };
  addKnown('', projectDir);
  if (config.target) addKnown(`${config.target.path}/`, join(projectDir, config.target.path));

  // Request files come from the default branch, whatever the pull request changed.
  const atDefault = (path) => tryGit(projectDir, 'show', `${defaultBranch}:${path}`) ?? tryGit(projectDir, 'show', `origin/${defaultBranch}:${path}`);
  let contextText = null;
  if (selection.context) {
    contextText = atDefault(selection.context);
    if (contextText === null) return finish(blocked('gate', `context file not found: ${selection.context}`));
    contextText = contextText.slice(0, MAX_CONTEXT_CHARS);
  }
  const warnings = [];
  let planText = null;
  if (meta.task) {
    planText = atDefault(meta.task.plan);
    if (planText === null) warnings.push(`plan file not found: ${meta.task.plan}`);
  }
  const prText = selection.prs.map((p) => `### ${p.repo}#${p.number}: ${p.title}\n\n${p.body || '(no description)'}`).join('\n\n');
  const planTask = [
    planText ? planTaskSection(planText, meta.task.task) : '(no plan task found; judge the change against the pull request descriptions)',
    '## Pull requests',
    prText,
    ...(contextText ? ['## Context', contextText] : []),
  ].join('\n\n');

  const tokens = claudeTokens(env);
  let accounts = tokens.map((token, i) => ({ token, account: i + 1 }));
  if (tokens.length && !(env.AGENT_CMD && !env.AGENT_PROBE_CMD)) {
    const { usable, limited } = await probeAccounts({ tokens, model: meta.model, env, projectDir, logsDir });
    if (usable.length === 0) {
      if (limited > 0) return finish({ outcome: 'WAITING', kind: 'usage-limit', reasons: [`usage limit reached on all ${tokens.length} Claude accounts`] });
      return finish(blocked('agent', 'Claude did not respond on any account; see logs/probe-*.log'));
    }
    accounts = usable;
  }
  if (accounts.length === 0) accounts = [{ token: undefined, account: null }];

  const runStep = (command, logName, timeoutSec, extra = {}) =>
    runWithTimeout(command, { cwd: projectDir, timeoutSec, logFile: join(logsDir, logName), env: quietEnv, ...extra });
  const install = await runStep(config.install, 'install.log', config.timeouts.install);
  if (install.timedOut || install.exitCode !== 0) {
    return finish(blocked('harness', install.timedOut ? 'install timed out' : `install failed (exit ${install.exitCode})`));
  }
  if (config.setup) {
    const setup = await runStep(config.setup, 'setup.log', config.timeouts.setup, { killGroupOnExit: false });
    if (setup.timedOut || setup.exitCode !== 0) {
      return finish(blocked('harness', setup.timedOut ? 'setup timed out' : `setup failed (exit ${setup.exitCode})`));
    }
  }

  state.snaps = snapshot(known.map((r) => r.dir));
  const skillDir = join(outDir, 'review-skill');
  const skill = copySkill(known, rc.skill, skillDir);
  if (skill.error) return finish(blocked('agent', skill.error, { warnings }));

  const started = Date.now();
  const session = createSession({
    envConfig: config.env, accounts, env, projectDir, outDir, logsDir, maxTurns: rc.maxTurns,
    remainingSec: () => rc.timeout - (Date.now() - started) / 1000,
  });
  const step = await reviewStep({
    n: 1, repos, session, model: rc.model, templates: reviewTemplates(),
    input: { goal: planText ? planGoal(planText) : '', skillDir, planTask, rules: readRules(known, rc.rules), history: '(first review)' },
    env, outDir, warnings,
  });
  enforceReadOnly(state.snaps);

  if (step.limited) {
    return finish({ outcome: 'WAITING', kind: 'usage-limit', reasons: [`usage limit reached on all ${Math.max(tokens.length, 1)} Claude accounts`], warnings });
  }
  if (step.timedOut) return finish(blocked('agent', 'review timed out', { warnings }));
  if (step.error) return finish(blocked('agent', `invalid review: ${step.error}`, { warnings }));
  const confirmed = actionable(step.findings);
  const verdict = confirmed.some((f) => f.severity === 'high') ? 'changes' : confirmed.length ? 'comments' : 'clean';
  return finish({ outcome: 'REVIEWED', warnings, review: { verdict, findings: step.findings } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' }, issue: { type: 'string' }, out: { type: 'string' }, config: { type: 'string' },
      selection: { type: 'string' }, 'default-branch': { type: 'string' },
    },
  });
  for (const k of ['project', 'issue', 'out', 'selection', 'default-branch']) {
    if (!values[k]) {
      console.error(`missing --${k}`);
      process.exit(2);
    }
  }
  const verdict = await runReview({
    projectDir: values.project,
    issue: JSON.parse(readFileSync(values.issue, 'utf8')),
    outDir: values.out,
    configPath: values.config,
    selection: JSON.parse(readFileSync(values.selection, 'utf8')),
    defaultBranch: values['default-branch'],
  });
  console.log(`${verdict.outcome}${verdict.kind ? ` (${verdict.kind})` : ''}: ${verdict.reasons.join('; ') || verdict.review?.verdict || ''}`);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/review-run.test.mjs && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/review-run.mjs test/review-run.test.mjs
git commit -m "feat: review runner"
```

---

## Task 6: feat: render pull request reviews into the issue body

**Files:**
- Create: `harness/lib/pr-review-format.mjs`
- Modify: `harness/cli.mjs`
- Test: `test/pr-review-format.test.mjs`

**Interfaces:**
- Consumes: `REVIEW_MARKER`, `requestText` (Task 1); `actionable` from `harness/lib/review.mjs`; review verdict (Task 5).
- Produces: `renderPrReview(verdict, { runUrl })` → section string; `mergeIssueBody(currentBody, verdict, { runUrl })` → new issue body; `renderReviewBlocked(verdict, { runUrl })` → comment. CLI: `render-pr-review --verdict <f> --body <f> --run-url <u>` (prints the new body); `render-review-blocked --verdict <f> --run-url <u>`.

- [ ] **Step 1: Write the failing tests** — create `test/pr-review-format.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderPrReview, mergeIssueBody, renderReviewBlocked } from '../harness/lib/pr-review-format.mjs';

const CLI = new URL('../harness/cli.mjs', import.meta.url).pathname;
const HEAD = 'a1b2c3d'.padEnd(40, '0');
const f = (id, severity, extra = {}) => ({ id, severity, file: 'target/src/app.ts', line: 42, rule: 'plan-mismatch', problem: `Problem ${id}.`, fix: `Fix ${id}.`, ...extra });
const verdict = (findings, review = 'changes', extra = {}) => ({
  mode: 'review', outcome: 'REVIEWED', model: 'opus', warnings: [],
  prs: [{ repo: 'o/super', number: 12, url: 'u', headSha: HEAD, baseSha: 'b', prefix: 'target/' }],
  review: { verdict: review, findings }, ...extra,
});

test('a review with findings', () => {
  const text = renderPrReview(verdict([
    f('R1', 'high', { verification: 'CONFIRMED' }),
    f('R2', 'medium', { verification: 'CONFIRMED', line: 7, file: 'target/lib/x.ts', fix: '' }),
    f('R3', 'low', { line: null }),
    f('R4', 'high', { verification: 'WITHDRAWN', evidence: 'never null' }),
  ]), { runUrl: 'https://run' });
  assert.equal(text, [
    '<!-- agent-pr-review -->',
    '## 🔴 Changes requested · 1 high · 1 medium',
    '`o/super#12` @ a1b2c3d',
    '',
    `- 🔴 [\`src/app.ts:42\`](https://github.com/o/super/blob/${HEAD}/src/app.ts#L42) Problem R1. **Fix:** Fix R1.`,
    `- 🟡 [\`lib/x.ts:7\`](https://github.com/o/super/blob/${HEAD}/lib/x.ts#L7) Problem R2.`,
    '',
    '<details><summary>1 low · 1 withdrawn</summary>',
    '',
    `- low [\`src/app.ts\`](https://github.com/o/super/blob/${HEAD}/src/app.ts) Problem R3.`,
    `- withdrawn [\`src/app.ts:42\`](https://github.com/o/super/blob/${HEAD}/src/app.ts#L42) Problem R4. Evidence: never null`,
    '',
    '</details>',
    '',
    '<sub>opus · [run](https://run)</sub>',
  ].join('\n'));
});

test('a clean review is one heading and the pull request line', () => {
  assert.equal(renderPrReview(verdict([], 'clean'), {}), '<!-- agent-pr-review -->\n## 🟢 Looks good\n`o/super#12` @ a1b2c3d\n\n<sub>opus</sub>');
});

test('long sentences are cut', () => {
  const text = renderPrReview(verdict([f('R1', 'medium', { verification: 'CONFIRMED', problem: 'p'.repeat(300) })], 'comments'), {});
  assert.match(text, /^## 🟡 Comments · 1 medium$/m);
  assert.match(text, new RegExp(`${'p'.repeat(159)}… \\*\\*Fix:\\*\\*`));
});

test('a second review replaces the first', () => {
  const first = mergeIssueBody('pr: o/super#12\nplease check', verdict([], 'clean'), {});
  assert.ok(first.startsWith('pr: o/super#12\nplease check\n\n<!-- agent-pr-review -->\n## 🟢 Looks good'));
  const second = mergeIssueBody(first, verdict([f('R1', 'high', { verification: 'CONFIRMED' })]), {});
  assert.equal(second.split('<!-- agent-pr-review -->').length, 2);
  assert.match(second, /Changes requested/);
  assert.doesNotMatch(second, /Looks good/);
});

test('an oversized review is cut to fit', () => {
  const lows = Array.from({ length: 2000 }, (_, i) => f(`R${i + 1}`, 'low', { problem: 'x'.repeat(150) }));
  const body = mergeIssueBody('pr: o/super#12', verdict([f('R9999', 'high', { verification: 'CONFIRMED' }), ...lows]), {});
  assert.ok(body.length <= 60000);
  assert.match(body, /<!-- agent-pr-review -->\n## 🔴 Changes requested/);
  assert.match(body, /\(cut\)<\/summary>/);
});

test('blocked comment and cli', () => {
  const v = { mode: 'review', outcome: 'BLOCKED', kind: 'harness', reasons: ['pull request checkout failed'] };
  assert.equal(renderReviewBlocked(v, { runUrl: 'https://run' }),
    '⛔ **BLOCKED** (harness)\n\n- pull request checkout failed\n\n[Run log and artifacts](https://run)\n\nTo retry: remove `agent:blocked` and add `review`.');
  const dir = mkdtempSync(join(tmpdir(), 'review-format-'));
  writeFileSync(join(dir, 'v.json'), JSON.stringify(verdict([], 'clean')));
  writeFileSync(join(dir, 'body.md'), 'pr: o/super#12\n');
  const out = execFileSync('node', [CLI, 'render-pr-review', '--verdict', join(dir, 'v.json'), '--body', join(dir, 'body.md'), '--run-url', 'https://run'], { encoding: 'utf8' });
  assert.ok(out.startsWith('pr: o/super#12\n\n<!-- agent-pr-review -->'));
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/pr-review-format.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — create `harness/lib/pr-review-format.mjs`:

```js
// A pull request review as a short block in the issue body: verdict, one line per confirmed finding,
// everything else folded.
import { REVIEW_MARKER, requestText } from './pr-review.mjs';
import { actionable } from './review.mjs';

const BODY_LIMIT = 60000;
const HEADINGS = { changes: '🔴 Changes requested', comments: '🟡 Comments', clean: '🟢 Looks good' };
const ICONS = { high: '🔴', medium: '🟡' };

const cut = (text, max = 160) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function where(prs, f) {
  const pr = prs.filter((p) => f.file.startsWith(p.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  const rel = pr ? f.file.slice(pr.prefix.length) : f.file;
  const label = `\`${rel}${f.line ? `:${f.line}` : ''}\``;
  return pr ? `[${label}](https://github.com/${pr.repo}/blob/${pr.headSha}/${rel}${f.line ? `#L${f.line}` : ''})` : label;
}

function parts(v, { runUrl } = {}) {
  const findings = v.review.findings;
  const confirmed = actionable(findings);
  const counts = ['high', 'medium']
    .map((s) => [s, confirmed.filter((f) => f.severity === s).length])
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`);
  const low = findings.filter((f) => f.severity === 'low');
  const gone = findings.filter((f) => f.verification === 'WITHDRAWN');
  const warnings = v.warnings ?? [];
  return {
    head: [
      REVIEW_MARKER,
      `## ${[HEADINGS[v.review.verdict], ...counts].join(' · ')}`,
      v.prs.map((p) => `\`${p.repo}#${p.number}\` @ ${p.headSha.slice(0, 7)}`).join(' · '),
      ...(confirmed.length ? ['', ...confirmed.map((f) => `- ${ICONS[f.severity]} ${where(v.prs, f)} ${cut(f.problem)}${f.fix ? ` **Fix:** ${cut(f.fix)}` : ''}`)] : []),
    ],
    folded: [
      ...low.map((f) => `- low ${where(v.prs, f)} ${cut(f.problem)}`),
      ...gone.map((f) => `- withdrawn ${where(v.prs, f)} ${cut(f.problem)} Evidence: ${cut(f.evidence)}`),
      ...warnings.map((w) => `- warning: ${cut(w, 300)}`),
    ],
    summary: [
      low.length && `${low.length} low`,
      gone.length && `${gone.length} withdrawn`,
      warnings.length && `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · '),
    tail: `<sub>${v.model}${runUrl ? ` · [run](${runUrl})` : ''}</sub>`,
    cutNote: false,
  };
}

function compose(p) {
  const fold = p.folded.length
    ? ['', `<details><summary>${p.summary}${p.cutNote ? ' (cut)' : ''}</summary>`, '', ...p.folded, '', '</details>']
    : [];
  return [...p.head, ...fold, '', p.tail].join('\n');
}

export const renderPrReview = (v, opts) => compose(parts(v, opts));

// Keeps the request above the marker and replaces any earlier review; folded lines go first when too long.
export function mergeIssueBody(current, v, opts = {}) {
  const request = requestText(current).trimEnd();
  const room = BODY_LIMIT - request.length - 3;
  const p = parts(v, opts);
  let section = compose(p);
  while (section.length > room && p.folded.length) {
    p.folded.length = Math.floor(p.folded.length * 0.8);
    p.cutNote = true;
    section = compose(p);
  }
  if (section.length > room) section = `${section.slice(0, room - 20)}\n\n[truncated]`;
  return `${request}\n\n${section}\n`;
}

export function renderReviewBlocked(v, { runUrl } = {}) {
  return [
    `⛔ **BLOCKED** (${v.kind})`, '', ...v.reasons.map((r) => `- ${r}`), '', `[Run log and artifacts](${runUrl})`, '',
    'To retry: remove `agent:blocked` and add `review`.',
  ].join('\n');
}
```

- [ ] **Step 4: Add the CLI commands** — in `harness/cli.mjs`: import `mergeIssueBody, renderReviewBlocked` from `./lib/pr-review-format.mjs`; append to `USAGE`:

```
  cli.mjs render-pr-review --verdict <f> --body <f> --run-url <u>
  cli.mjs render-review-blocked --verdict <f> --run-url <u>
```

and add before the `render-debug-comment` case:

```js
  case 'render-pr-review':
    process.stdout.write(mergeIssueBody(readFileSync(values.body, 'utf8'), read(values.verdict), { runUrl: values['run-url'] }));
    break;
  case 'render-review-blocked':
    process.stdout.write(renderReviewBlocked(read(values.verdict), { runUrl: values['run-url'] }));
    break;
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/pr-review-format.test.mjs && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add harness/lib/pr-review-format.mjs harness/cli.mjs test/pr-review-format.test.mjs
git commit -m "feat: render pull request reviews into the issue body"
```

---

## Task 7: feat: publish review runs; labels, template and docs

**Files:**
- Create: `harness/publish-review.sh`
- Modify: `harness/lib/bootstrap.mjs`
- Modify: `templates/agent.yml`
- Modify: `test/stubs/gh`
- Modify: `README.md`
- Test: `test/review-publish-run.test.mjs`

**Interfaces:**
- Consumes: CLI `render-pr-review`, `render-review-blocked` (Task 6).
- Produces: `publish-review.sh` with env `VERDICT`, `REPO`, `GH_TOKEN`, `RUN_URL`; labels `review`, `agent:review-done` in `LABELS`; caller template job `review`; gh stub env `GH_ISSUE_BODY` (printed by `gh issue view`).

- [ ] **Step 1: Let the gh stub return an issue body** — in `test/stubs/gh`, add this case before `esac`:

```sh
  "issue view")
    printf '%s' "$GH_ISSUE_BODY" ;;
```

- [ ] **Step 2: Write the failing tests** — create `test/review-publish-run.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LABELS } from '../harness/lib/bootstrap.mjs';

const PUBLISH = new URL('../harness/publish-review.sh', import.meta.url).pathname;
const STUBS = new URL('./stubs', import.meta.url).pathname;
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const HEAD = 'a'.repeat(40);

const base = {
  mode: 'review', kind: null, reasons: [], warnings: [], issue: 30, issueTitle: 'Review', model: 'opus',
  prs: [{ repo: 'o/r', number: 5, url: 'u', headSha: HEAD, baseSha: 'b', prefix: '' }], task: null,
};

function publish(verdict, body = 'pr: o/r#5\n') {
  const dir = mkdtempSync(join(tmpdir(), 'review-publish-'));
  writeFileSync(join(dir, 'v.json'), JSON.stringify(verdict));
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [PUBLISH], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${STUBS}:${process.env.PATH}`, GH_LOG: log, GH_ISSUE_BODY: body,
      VERDICT: join(dir, 'v.json'), REPO: 'o/r', GH_TOKEN: 'x', RUN_URL: 'https://run',
    },
  });
  return { status: r.status, stderr: r.stderr, log: readFileSync(log, 'utf8') };
}

test('labels exist', () => {
  assert.ok(LABELS.includes('review'));
  assert.ok(LABELS.includes('agent:review-done'));
});

test('a review rewrites the issue body and marks it done', () => {
  const { status, stderr, log } = publish({ ...base, outcome: 'REVIEWED', review: { verdict: 'clean', findings: [] } }, 'pr: o/r#5\nplease\n');
  assert.equal(status, 0, stderr);
  assert.match(log, /gh issue view 30 --repo o\/r --json body -q \.body/);
  assert.match(log, /gh issue edit 30 --repo o\/r --body-file \S+\npr: o\/r#5\nplease\n\n<!-- agent-pr-review -->\n## 🟢 Looks good/);
  assert.match(log, /--remove-label review --add-label agent:review-done/);
  assert.doesNotMatch(log, /gh issue comment/);
});

test('a blocked run comments and labels', () => {
  const { status, log } = publish({ ...base, outcome: 'BLOCKED', kind: 'harness', reasons: ['pull request checkout failed'], review: null });
  assert.equal(status, 0);
  assert.match(log, /--remove-label review --add-label agent:blocked/);
  assert.match(log, /gh issue comment 30[\s\S]*⛔ \*\*BLOCKED\*\* \(harness\)\n\n- pull request checkout failed/);
  assert.doesNotMatch(log, /--body-file \S+\npr:/);
});

test('waiting leaves the issue queued', () => {
  const { status, log } = publish({ ...base, outcome: 'WAITING', kind: 'usage-limit', reasons: ['x'], review: null });
  assert.equal(status, 0);
  assert.doesNotMatch(log, /--remove-label review/);
  assert.doesNotMatch(log, /gh issue comment/);
});

test('the caller template runs reviews after debug, on the owner label only', () => {
  const y = read('../templates/agent.yml');
  assert.match(y, /\n  review:\n    needs: \[agent, debug\]\n/);
  assert.match(y, /github\.event\.label\.name == 'review' && github\.event\.sender\.login == github\.repository_owner/);
  assert.match(y, /run-review\.yml@v1/);
});

test('README documents review runs', () => {
  const readme = read('../README.md');
  assert.match(readme, /^## Review runs$/m);
  for (const word of ['pr: owner/repo#123', '<!-- agent-pr-review -->', 'agent:review-done', '50,000', 'TARGET_READ_TOKEN']) assert.ok(readme.includes(word), word);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test test/review-publish-run.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Labels** — in `harness/lib/bootstrap.mjs`, append `'review', 'agent:review-done'` to `LABELS`.

- [ ] **Step 5: Publish script** — create `harness/publish-review.sh`:

```bash
#!/usr/bin/env bash
# Publishes a review run: rewrites the issue body below the review marker, or comments why the run
# was blocked. Never touches branches or pull requests.
set -Eeuo pipefail
: "${VERDICT:?}" "${REPO:?}" "${GH_TOKEN:?}" "${RUN_URL:?}"

CLI="$(cd "$(dirname "$0")" && pwd)/cli.mjs"
TMP=$(mktemp -d)
issue=$(jq -r .issue "$VERDICT")
outcome=$(jq -r .outcome "$VERDICT")
stage="start"

# Whatever fails below, the issue must end labelled and commented.
on_error() {
  local code=$?
  trap - ERR
  printf '%s\n' "⛔ **BLOCKED** (harness)" "" "- publishing failed at step: ${stage}" "" \
    "[Run log and artifacts](${RUN_URL})" "" 'To retry: remove `agent:blocked` and add `review`.' > "$TMP/fail.md"
  gh issue edit "$issue" --repo "$REPO" --remove-label agent:running --remove-label review --add-label agent:blocked >/dev/null 2>&1 || true
  gh issue comment "$issue" --repo "$REPO" --body-file "$TMP/fail.md" >/dev/null 2>&1 || true
  exit "$code"
}
trap on_error ERR

stage="labels"
gh issue edit "$issue" --repo "$REPO" --remove-label agent:running --remove-label agent:blocked --remove-label agent:review-done >/dev/null || true
case "$outcome" in
  REVIEWED)
    stage="body"
    gh issue view "$issue" --repo "$REPO" --json body -q .body > "$TMP/body.md"
    node "$CLI" render-pr-review --verdict "$VERDICT" --body "$TMP/body.md" --run-url "$RUN_URL" > "$TMP/new.md"
    gh issue edit "$issue" --repo "$REPO" --body-file "$TMP/new.md" >/dev/null
    stage="label-outcome"
    gh issue edit "$issue" --repo "$REPO" --remove-label review --add-label agent:review-done >/dev/null
    ;;
  WAITING) ;;
  *)
    stage="label-outcome"
    gh issue edit "$issue" --repo "$REPO" --remove-label review --add-label agent:blocked >/dev/null
    stage="comment"
    node "$CLI" render-review-blocked --verdict "$VERDICT" --run-url "$RUN_URL" > "$TMP/comment.md"
    gh issue comment "$issue" --repo "$REPO" --body-file "$TMP/comment.md" >/dev/null
    ;;
esac
echo "published ${outcome} for #${issue}"
```

Make it executable: `chmod +x harness/publish-review.sh`.

- [ ] **Step 6: Caller template** — append to `templates/agent.yml`, after the `debug` job:

```yaml

  # Read-only reviews of existing pull requests, for issues labelled `review` whose body lists
  # them as `pr: owner/repo#123`. The review is written into the issue body. Runs after `debug`.
  review:
    needs: [agent, debug]
    if: ${{ always() && (github.event_name != 'issues' || (github.event.label.name == 'review' && github.event.sender.login == github.repository_owner)) }}
    uses: OWNER/agent-harness/.github/workflows/run-review.yml@v1
    with:
      harness_repo: OWNER/agent-harness
      harness_ref: v1
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      CLAUDE_CODE_OAUTH_TOKEN_2: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_2 }}
      # Optional: review pull requests in a separate target repository (README, "Review runs").
      # TARGET_READ_TOKEN: ${{ secrets.TARGET_READ_TOKEN }}
```

- [ ] **Step 7: README** — add before `## Usage limits and a second account`:

~~~markdown
## Review runs

A `review` label reviews pull requests that already exist, read-only, with the project's review skill (the `review` block, see "Review loop"). Nothing is posted to the pull request, fixed or committed: the review is written into the issue that asked for it.

Open an issue whose body lists the pull requests, one per repository, then add the `review` label:

```
pr: owner/repo#123
pr: https://github.com/owner/sub/pull/45
context: docs/notes.md
```

- Pull requests must belong to this repository, its `target` or one of the target's submodules. Pull requests in a target need the `TARGET_READ_TOKEN` secret.
- When a pull request came from a harness task, the reviewer also gets that task's plan goal and section.
- The reviewer runs the skill unattended, may run commands and start subagents, and must anchor every high and medium finding to a changed line; a verifier then tries to refute each one.
- Above 50,000 changed lines the run is skipped.

The result replaces everything below `<!-- agent-pr-review -->` in the issue body (your text above it is kept): a verdict, one line per confirmed high or medium finding linked to the line at the pull request head, and lows, withdrawn findings and warnings folded. The label becomes `agent:review-done`; re-add `review` to review again. A blocked run gets `agent:blocked` and a comment; retry by removing it and adding `review`.

Add the `review` job from `templates/agent.yml` to the caller workflow; `bootstrap.mjs` creates the labels.
~~~

- [ ] **Step 8: Run the tests**

Run: `node --test test/review-publish-run.test.mjs && npm test`
Expected: all PASS, including `test/templates.test.mjs` and `test/publish-debug.test.mjs`.

- [ ] **Step 9: Commit**

```bash
git add harness/publish-review.sh harness/lib/bootstrap.mjs templates/agent.yml test/stubs/gh README.md test/review-publish-run.test.mjs
git commit -m "feat: publish review runs; labels, template and docs"
```

---

## Task 8: chore: review run workflow (manual)

`.github/**` is protected, so this is added by hand after Tasks 1–7 are merged.

**Files:**
- Create: `.github/workflows/run-review.yml`

- [ ] **Step 1:** Create `.github/workflows/run-review.yml`:

```yaml
name: agent-run-review

# Read-only review of existing pull requests for an issue labelled `review`. Same three-VM split as
# run-debug.yml: the agent never shares a machine with a write-capable token.
#   select  — picks the oldest review issue, reads its pull requests (issues: write, read tokens)
#   run     — checks out the pull request heads and runs the reviewer (contents: read, Claude token only)
#   publish — rewrites the issue body and swaps labels (issues: write)

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
      claude_code_version:
        type: string
        default: '2.1.283'
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN:
        required: true
      CLAUDE_CODE_OAUTH_TOKEN_2:
        required: false
      TARGET_READ_TOKEN:
        required: false

jobs:
  select:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      issues: write
      pull-requests: read
    outputs:
      issue: ${{ steps.select.outputs.issue }}
      skipped: ${{ steps.select.outputs.skipped }}
      default: ${{ steps.select.outputs.default }}
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
          for l in review agent:running agent:blocked agent:review-done; do
            gh label create "$l" --repo "$GITHUB_REPOSITORY" --color 5319e7 >/dev/null 2>&1 || true
          done

      - name: Select next review issue
        id: select
        env:
          GH_TOKEN: ${{ github.token }}
          TARGET_READ_TOKEN: ${{ secrets.TARGET_READ_TOKEN }}
        run: |
          mkdir -p "$RUNNER_TEMP/agent"
          cd "$RUNNER_TEMP/agent"
          cli="$GITHUB_WORKSPACE/.harness/harness/cli.mjs"
          gh issue list --repo "$GITHUB_REPOSITORY" --state open --label review --limit 200 --json number,title,body,labels > issues.json
          default=$(gh repo view "$GITHUB_REPOSITORY" --json defaultBranchRef -q .defaultBranchRef.name)
          node "$cli" select-review --issues issues.json > selection.json
          echo '[]' > prs.json
          echo '[]' > candidates.json
          if [ "$(jq -r '.issue != null and .skip == null' selection.json)" = "true" ]; then
            for row in $(jq -c '.prs[]' selection.json); do
              repo=$(jq -r .repo <<<"$row")
              n=$(jq -r .number <<<"$row")
              token="$TARGET_READ_TOKEN"
              [ "$repo" = "$GITHUB_REPOSITORY" ] && token="$GH_TOKEN"
              data=$(GH_TOKEN="$token" gh pr view "$n" --repo "$repo" --json url,title,body,headRefOid,baseRefName,additions,deletions 2>/dev/null || echo null)
              jq --argjson d "$data" '. + [$d]' prs.json > t.json && mv t.json prs.json
              gh issue list --repo "$GITHUB_REPOSITORY" --state all --search "$n in:comments" --limit 30 --json number,body,comments > c.json || echo '[]' > c.json
              jq -s 'add' candidates.json c.json > t.json && mv t.json candidates.json
            done
            node "$cli" review-selection --selection selection.json --prs prs.json --candidates candidates.json > s.json
            mv s.json selection.json
          fi
          cat selection.json
          jq '.issue' selection.json > issue.json
          {
            echo "issue=$(jq -r '.issue.number // empty' selection.json)"
            echo "skipped=$(jq -r 'if .skip then "true" else "false" end' selection.json)"
            echo "default=$default"
          } >> "$GITHUB_OUTPUT"

      - name: Claim issue
        if: steps.select.outputs.issue != ''
        env:
          GH_TOKEN: ${{ github.token }}
          ISSUE: ${{ steps.select.outputs.issue }}
        run: gh issue edit "$ISSUE" --repo "$GITHUB_REPOSITORY" --add-label agent:running

      - name: Upload selection
        if: steps.select.outputs.issue != ''
        uses: actions/upload-artifact@v4
        with:
          name: agent-review-selection
          path: |
            ${{ runner.temp }}/agent/selection.json
            ${{ runner.temp }}/agent/issue.json
          retention-days: 14

  run:
    needs: select
    if: needs.select.outputs.issue != '' && needs.select.outputs.skipped == 'false'
    runs-on: ubuntu-latest
    timeout-minutes: 150
    permissions:
      contents: read
    steps:
      - name: Checkout harness
        uses: actions/checkout@v4
        with:
          repository: ${{ inputs.harness_repo }}
          ref: ${{ inputs.harness_ref }}
          path: .harness
          persist-credentials: false

      - name: Download selection
        uses: actions/download-artifact@v4
        with:
          name: agent-review-selection
          path: ${{ runner.temp }}/agent

      - name: Checkout project
        uses: actions/checkout@v4
        with:
          path: project
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node_version }}

      - name: Install tooling
        env:
          CLAUDE_CODE_VERSION: ${{ inputs.claude_code_version }}
        run: |
          corepack enable
          npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

      - name: Copy config
        run: cp project/agent.config.json "$RUNNER_TEMP/agent/default.agent.config.json"

      - name: Target info
        id: target
        env:
          HAS_TARGET_READ_TOKEN: ${{ secrets.TARGET_READ_TOKEN != '' }}
        run: >-
          node .harness/harness/cli.mjs debug-info
          --config "$RUNNER_TEMP/agent/default.agent.config.json"
          --selection "$RUNNER_TEMP/agent/selection.json"
          --out "$RUNNER_TEMP/agent" >> "$GITHUB_OUTPUT"

      - name: Checkout target
        id: checkout_target
        if: steps.target.outputs.repo != ''
        continue-on-error: true
        uses: actions/checkout@v4
        with:
          repository: ${{ steps.target.outputs.repo }}
          token: ${{ secrets.TARGET_READ_TOKEN }}
          submodules: recursive
          fetch-depth: 0
          path: project/${{ steps.target.outputs.path }}
          persist-credentials: false

      - name: Plan pull request checkouts
        run: >-
          node .harness/harness/cli.mjs review-checkouts
          --config "$RUNNER_TEMP/agent/default.agent.config.json"
          --selection "$RUNNER_TEMP/agent/selection.json"
          --repo "$GITHUB_REPOSITORY" --project project --out "$RUNNER_TEMP/agent"

      # Tokens live in this step only: not on disk, not in the agent's environment.
      - name: Check out pull requests
        id: checkout_prs
        if: hashFiles(format('{0}/agent/checkout-plan.json', runner.temp)) != ''
        continue-on-error: true
        env:
          PLAN: ${{ runner.temp }}/agent/checkout-plan.json
          PROJECT: project
          OUT: ${{ runner.temp }}/agent/prs-checked.json
          CONSUMER_TOKEN: ${{ github.token }}
          TARGET_TOKEN: ${{ secrets.TARGET_READ_TOKEN }}
        run: bash .harness/harness/checkout-prs.sh

      - name: Record checkout failure
        if: steps.checkout_prs.outcome == 'failure' || steps.checkout_target.outcome == 'failure'
        run: echo "pull request checkout failed" > "$RUNNER_TEMP/agent/pr-checkout.txt"

      - name: Run review
        timeout-minutes: 135
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN_2: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_2 }}
        run: >-
          node .harness/harness/review-run.mjs
          --project project
          --issue "$RUNNER_TEMP/agent/issue.json"
          --out "$RUNNER_TEMP/agent"
          --selection "$RUNNER_TEMP/agent/selection.json"
          --default-branch "${{ needs.select.outputs.default }}"
          --config "$RUNNER_TEMP/agent/default.agent.config.json"

      - name: Upload run results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: agent-review-run-issue-${{ needs.select.outputs.issue }}
          path: ${{ runner.temp }}/agent
          if-no-files-found: warn
          retention-days: 14

  publish:
    needs: [select, run]
    if: always() && needs.select.outputs.issue != ''
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      issues: write
      actions: write
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

      - name: Download selection
        uses: actions/download-artifact@v4
        with:
          name: agent-review-selection
          path: ${{ runner.temp }}/selection

      - name: Download run results
        if: needs.run.result != 'skipped'
        continue-on-error: true
        uses: actions/download-artifact@v4
        with:
          name: agent-review-run-issue-${{ needs.select.outputs.issue }}
          path: ${{ runner.temp }}/agent

      - name: Publish result
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          SKIPPED: ${{ needs.select.outputs.skipped }}
          RUN_RESULT: ${{ needs.run.result }}
        run: |
          mkdir -p "$RUNNER_TEMP/agent"
          sel="$RUNNER_TEMP/selection/selection.json"
          export VERDICT="$RUNNER_TEMP/publish-verdict.json"
          if [ "$SKIPPED" = "true" ]; then
            node .harness/harness/cli.mjs review-skip-verdict --selection "$sel" > "$VERDICT"
          elif [ "$RUN_RESULT" = "success" ] && [ -f "$RUNNER_TEMP/agent/verdict.json" ]; then
            cp "$RUNNER_TEMP/agent/verdict.json" "$VERDICT"
          else
            node .harness/harness/cli.mjs review-fallback-verdict --selection "$sel" > "$VERDICT"
          fi
          bash .harness/harness/publish-review.sh

      - name: Continue queue
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
          CALLER: ${{ inputs.caller_workflow }}
          DEFAULT_BRANCH: ${{ needs.select.outputs.default }}
        run: |
          if [ "$(jq -r .outcome "$RUNNER_TEMP/publish-verdict.json" 2>/dev/null)" = "WAITING" ]; then
            echo "paused: usage limit on all accounts"
            exit 0
          fi
          remaining=$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --label review --json number -q 'length')
          if [ "$remaining" -gt 0 ]; then
            gh workflow run "$CALLER" --repo "$GITHUB_REPOSITORY" --ref "$DEFAULT_BRANCH"
          fi
```

- [ ] **Step 2:** Run `npm test`. Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add .github/workflows/run-review.yml
git commit -m "chore: review run workflow"
```

---

## Task 9: Dry run (manual)

- [ ] **Step 1:** In the sandbox consumer, add the `review` job from `templates/agent.yml` to its caller workflow (pinned like its other jobs).
- [ ] **Step 2:** Open an issue `pr: <sandbox repo>#<an open pull request>` and add `review`. Pass when the issue body gains the review block below the marker, the label becomes `agent:review-done`, and every line link opens the right line at the pull request head.
- [ ] **Step 3:** Re-add `review` on the same issue. Pass when the block is replaced, not duplicated.
- [ ] **Step 4:** For a consumer with a `target`: add the `review` job with `TARGET_READ_TOKEN`, open an issue listing a target pull request (and its submodule pull request, if any), and compare the result against a hand review of the same pull request.
