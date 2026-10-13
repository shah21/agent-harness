# Review loop — design

_2026-10-13. Extends `2026-10-02-agent-harness-design.md` (§5 config, §6 run flow, §9 security), `2026-10-06-target-repos-design.md` (target clones) and reuses the read-only guard from `2026-10-09-debug-agent-design.md`._

## 1. Purpose

Today the only review of an agent's change is its own `SELF_REVIEW` plus the advisory plan-conformance check. A self-review shares the implementer's context and blind spots, and checks only catch what tests cover.

Add an opt-in **review → fix loop** inside the task run: after a task reaches `READY_FOR_QA`, a fresh read-only reviewer judges the change against the plan task and the project's own rules; high and medium findings go to a fresh fixer; checks run again; repeat until clean or an exit condition fires. Every round is reported on the task issue.

Success: with `review` configured, a READY task's issue shows one comment per round (findings, what was fixed, what was declined, checks after the fix) and a summary; the published HEAD is always a state whose checks passed. **A consumer without a `review` block behaves exactly as today.**

## 2. Boundary: generic harness, project rules in the consumer

The harness holds only mechanics, the generic prompts and the severity rubric. Project standards, skills and context files live in the consumer repository (or its target clone) and are wired in by config paths, as with `debug.contextPaths`. The harness knows no project names or folder conventions.

## 3. Config

Optional block in `agent.config.json`; absent means no loop.

```json
"review": {
  "rules": ["docs/review/*.md", "target/AGENTS.md"],
  "model": "sonnet",
  "maxRounds": 2,
  "timeout": "40m",
  "maxTurns": 60
}
```

- `rules`: globs relative to the consumer root, same semantics as `debug.contextPaths` (`target/...` reaches into the target clone). Read from the **default branch** (consumer) or the target's base commit, never from the agent's branch, so the implementer cannot rewrite the rules it is judged by. Default `[]`.
- `model`: reviewer model. Default `sonnet`. The fixer uses the implementer's model (`agent:opus` applies to it too).
- `maxRounds`: integer 1–3, default 2. Counts **reviews**. A fix runs only when another review will check it, so `1` means review only (findings reported, nothing fixed) and `2` means review → fix → review.
- `timeout`: budget for the whole loop, default `40m`.
- `maxTurns`: per reviewer and fixer session, default 60.

Invalid values fail config loading, as for other blocks.

## 4. Flow

Placement: `harness/run-task.mjs`, after `decide()` and conformance, only when `outcome === 'READY_FOR_QA'` and `config.review` is set. Debug runs are never reviewed.

New files: `harness/lib/review.mjs` (pure logic: parsing, validation, fingerprints, exit decisions, `open` computation), `harness/review-prompt.md`, `harness/fix-prompt.md` (generic instructions and severity rubric).

Round *n*:

1. **Review.** Claude with tools `Read,Glob,Grep,Write` (no Edit or Bash; Write only so it can write its result to the file named by `AGENT_OUTPUT_PATH` under the run's output directory, as the implementer writes its report), wrapped in `snapshot` / `enforceReadOnly` from `harness/lib/debug-guard.mjs`. Inputs: the plan task text; `git diff <base>..HEAD` of the consumer and every target repo; the `rules` files; the nearest `AGENTS.md` / `CLAUDE.md` above each changed path (walk up from the path, consumer and target trees, read at base); findings and fixer replies of earlier rounds. Never the implementer's transcript. Output: findings JSON (§5).
2. **Exit check** (§6): clean, no progress, round cap, budget.
3. **Fix.** A fresh Claude session, implementer's model and tools, given the high and medium findings, the plan task and the diff. It commits once per repo it changes, message `fix: address review round <n>`, no trailers. Output: one reply per finding id (§5).
4. **Verify.** The existing `clean → reinstall → setup → runChecks` sequence, then the gate rules (protected paths, commit rules) on the new diff. Red checks or a gate violation: `git reset --hard` every repo (consumer and targets, submodule pointers included) to the last green SHA and exit.
5. Next round.

Low findings never trigger a fix round; they are reported only.

Once the loop starts, the outcome is always `READY_FOR_QA`. High and medium findings unresolved at exit are listed in `review.open` and flagged (§7).

### Budget

The run job timeout rises from 90 to 150 minutes and the agent step from 75 to 135. The loop knows only `review.timeout`: before each review after the first, and before each fix, it checks that the remaining budget exceeds the longest step so far; if not it exits `budget`. Each agent session's timeout is the remaining budget. A consumer whose implementation plus review budget would exceed the step timeout lowers `review.timeout`. A usage limit during the loop exits `usage-limit` with the last green state kept; it does not turn the task into `WAITING`, because the implementation is complete.

## 5. Contracts

### Reviewer output

One fenced JSON block:

```json
{ "status": "FINDINGS",
  "findings": [
    { "id": "R1", "severity": "high", "file": "src/x.ts", "line": 42,
      "rule": "plan-mismatch", "problem": "…", "fix": "…" } ] }
```

- `status`: `CLEAN` | `FINDINGS`. `severity`: `high` | `medium` | `low`.
- `rule`: short kebab-case slug, generic (`plan-mismatch`, `weakened-test`, `security`, `data-loss`, `missing-test`, `error-handling`, `scope-creep`, `style`) or defined by a project rule file.
- Malformed JSON, schema violation, or a high/medium finding whose `file` is not in the diff → exit `reviewer-error`; the parse error goes into the report.

### Severity rubric (generic)

- **high:** wrong behaviour, mismatch with the plan task, security issue, data loss, weakened or deleted tests.
- **medium:** missing test for new logic, violation of a project rule, missing or wrong error handling.
- **low:** style, naming, nits.

Project rule files may refine what falls under each level; they cannot add or rename levels.

### Fixer output

One line per finding id:

```
R1: FIXED
R2: WONTFIX: plan task 3 explicitly requires this shape
```

A missing id is `UNADDRESSED`, treated like `WONTFIX` for the next round. A fixer that makes no commit leaves every finding `UNADDRESSED`.

### No-progress fingerprint

`file + rule` (lines shift after fixes). If every high/medium fingerprint of round *n+1* already appeared in round *n*, the loop exits `no-progress`. The reviewer sees earlier `WONTFIX` reasons; re-raising one counts toward no progress.

### `verdict.review`

```json
{ "model": "sonnet",
  "exit": "clean",
  "rounds": [
    { "n": 1, "findings": [], "fixes": [ { "id": "R1", "result": "FIXED" } ],
      "commit": "abc123", "checks": {}, "reverted": false, "durationSec": 410 } ],
  "open": [] }
```

- `exit`: `clean` | `max-rounds` | `no-progress` | `fix-broke-checks` | `gate` | `budget` | `usage-limit` | `reviewer-error`.
- `fixes[].result`: `FIXED` | `WONTFIX` (with `reason`) | `UNADDRESSED`.
- `commit`: per round, the consumer SHA, plus `targets: { "<repo>": "<sha>" }` when targets changed.
- `checks`: the existing `{ ok, exitCode, timedOut, durationSec, tail }` shape.
- A final clean round has no `fixes` / `commit`.
- `open`: the high/medium findings of the last completed review. When a fix ran after that review (and no later review confirmed it), each finding carries that fix's `result`: `FIXED` (unconfirmed), `WONTFIX` with `reason`, `UNADDRESSED`, or `REVERTED` when the fix was discarded. Empty only on `clean`.
- Top-level `verdict.checks` holds the **final green** state so existing readers keep reading correct results. `verdict.commits` and `verdict.diff` cover the final HEAD.

The field is absent when no loop ran. This is the contract an external run-history collector stores.

## 6. Exits and failures

| Event | Action | `exit` |
|---|---|---|
| no high/medium findings | stop | `clean` |
| round cap reached | stop, keep HEAD | `max-rounds` |
| same fingerprints as last round | stop | `no-progress` |
| checks red after fix | reset all repos to last green | `fix-broke-checks` |
| fix violates gate rules | reset all repos to last green | `gate` |
| round does not fit remaining time | stop, keep last green | `budget` |
| usage limit on all accounts | stop, keep last green | `usage-limit` |
| reviewer output invalid | stop, keep HEAD | `reviewer-error` |
| reviewer changes the checkout | guard reverts, noted in the round, continue | — |
| harness error inside the loop | catch, reset to last green, stack in report | `reviewer-error` |

Invariant: **the published HEAD of every repo is the last state whose checks passed.**

## 7. Reporting

### Issue comments

Posted by the publish job, after the existing READY comment, in order:

1. One comment per round:

   ```
   ### Review round 1 — 2 high, 1 medium, 3 low
   | id | sev | file | rule | problem | result |
   | R1 | high | src/x.ts:42 | plan-mismatch | … | FIXED (abc123) |
   | R2 | medium | src/y.ts:7 | missing-test | … | WONTFIX: … |
   Checks after fix: ✅ test ✅ e2e
   <details><summary>3 low (not fixed)</summary>…</details>
   ```

   A reverted round shows `Reverted: checks failed after fix` (or `gate`) with the failing checks' tails.
2. A summary: exit reason, rounds used, open high/medium findings.

A failed comment post is logged and skipped; the job stays green. The verdict artifact holds everything.

### Label

Non-empty `open` adds `agent:review-open`; bootstrap creates it. Dashboards can show open review findings from labels alone.

### PR bodies

- Consumer PR: a short `## Review` section (exit reason, open findings), no per-round detail.
- Target PRs: unchanged by default. New template variable `{review}` (one-line summary plus open findings) lets a consumer opt in.

## 8. Security

- Reviewer: read-only tools, enforced by snapshot/revert, as debug runs.
- Neither agent receives a GitHub token; the run job's credentials are unchanged. Comments and labels are written by the publish job only.
- Rule files are read from base, not the agent's branch (§3).
- Rule text, diffs and earlier findings enter prompts as untrusted data.

## 9. Testing

`node:test`, existing patterns (`test/fake-agents`, `test/golden`):

- `test/review.test.mjs` (pure): output parsing and validation, fingerprints, each exit decision, severity filtering, `open` computation.
- `test/review-config.test.mjs`: defaults, bounds, invalid values, absent block → no loop.
- `test/review-pipeline.test.mjs` with fake agents: clean first round; fix then clean; round cap; no progress; red checks after fix → HEAD equals last green SHA; gate violation → revert; reviewer writes a file → reverted, loop continues; malformed output; usage limit; target-repo fix and revert across a superproject and submodule.
- `test/publish.test.mjs` and goldens: round comments, summary, `agent:review-open`, consumer PR `## Review`, `{review}` in a target template.
- Compatibility: without `review`, verdict, comment and PR goldens are byte-identical to today.

## 10. Rollout

1. Implementation tasks run as `agent` issues with the plan on `main`. The workflow timeout change touches `.github/**` (protected) and is a manual task.
2. Dry run on a sandbox consumer with a seeded defect the reviewer must find.
3. Tag a new release; a consumer opts in by repinning `uses:` and `harness_ref` to it and adding a `review` block plus its own rule files. Consumers on older tags are unaffected.

## 11. Out of scope

Live per-round comments during the run, reviewing debug runs, dashboard changes, run-history storage, auto-blocking on review findings.
