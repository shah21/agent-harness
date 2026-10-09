# Debug agent — design

_2026-10-09. Extends `2026-10-02-agent-harness-design.md` (§5 config, §6 run flow, §9 security) and `2026-10-06-target-repos-design.md` (target clones)._

## 1. Purpose

Let a consumer queue an **investigation** instead of an implementation: a labelled issue describes a symptom, an unattended agent investigates read-only, and the findings come back as comments on that issue. Nothing is committed, pushed or opened as a PR.

Success: labelling an issue `debug` yields, within the timeout, one comment with a fixed-format findings report (root cause or ranked hypotheses, evidence, unknowns, what human input would help). The checkout is unchanged afterwards. **A consumer that never uses the `debug` label behaves exactly as today.**

Later modes (brainstorming, fix proposals) are out of scope here; the runner is shaped so another prompt can reuse it (§9).

## 2. Trigger and issue shape

- Label **`debug`** (distinct from `agent`; the two never mix). Added to the consumer's labels by bootstrap.
- Issue body: free text describing the symptom, optionally one line `context: <path>` — a repo-relative file on the **default branch** (same rule as `plan:`). The harness reads it from the default branch, never from a stacked or agent branch. A missing or escaping path (`..`, absolute) ends `BLOCKED (gate)`.
- Optional line `ref: <branch|tag|sha>` — with `target` configured, the commit to investigate. The harness checks it out in the target clone (detached; submodules updated to the pointers it records). Default: the target's default branch. The harness fetches `ref` explicitly (branch, tag or SHA) and the tags needed for `log`/`blame` across versions, so a shallow or default-branch-only clone is not a limit. A ref that cannot be fetched ends `BLOCKED (gate)` with git's error. The report states the investigated SHA.
- Debug runs share the existing concurrency group: one select → run → publish chain per repository, in label order.
- Retrying: remove `agent:blocked` and re-add `debug`.

## 3. Configuration

One optional block in `agent.config.json`:

```json
{
  "debug": {
    "contextPaths": [".agents/context/**", "docs/architecture.md"],
    "timeout": "30m",
    "maxTurns": 60
  }
}
```

- **`contextPaths`** — globs (relative to the consumer root, so `target/...` reaches into the target clone) the agent is told to read first. The harness knows no folder names; the consumer defines its convention. Default `[]`.
- **`timeout`** — wall-clock cap for the agent. Default `30m`. Same duration syntax as `timeouts`.
- **`maxTurns`** — default `60`. Independent of the implementation `maxTurns`.
- `model` is reused (`agent:opus` upgrades a debug run too).
- `checks` are **not** run (§4). `install` and `setup` are.

## 4. Run flow (`harness/debug-run.mjs`)

Network-free like `run-task.mjs`; GitHub interaction stays in the workflow.

1. Load config, parse the issue (§2), read the context file.
2. Probe accounts and pick usable ones — the existing probe, reused as is. All accounts limited → `WAITING`.
3. Prepare the target clone when `target` is configured (existing code) and check out `ref` if given (§2). The prompt tells the agent the code under investigation lives in the target path, not the consumer root.
4. `install`, then `setup` if configured. **No baseline checks**: a red base is a possible finding, not a gate.
5. Record `HEAD` and `git status --porcelain` of the consumer and every target clone.
6. Run the agent with `harness/debug-prompt.md` rendered with: issue number and title, symptom text, context file text, `contextPaths`, report path, and the vendored skill (§6). Tools: `Read,Write,Glob,Grep,Bash` (no `Edit`). `--add-dir` is the output directory, as today.
7. **Read-only enforcement** (§5).
8. Parse and validate the report (§7), write `verdict.json`.

The agent's environment is the existing allowlist: no GitHub token, no target tokens, no push credentials.

## 5. Read-only is enforced

Prompting is not enough. After the agent exits (or times out):

- Compare `HEAD` and `git status --porcelain` with step 5, in the consumer and in each target clone (submodules included).
- Any difference — new commit, moved branch, modified, deleted or untracked-and-not-ignored file — is **reverted** (`reset --hard` to the recorded `HEAD`, `clean -fd`), and the verdict gains the warning `agent modified the checkout; changes were discarded`.
- Nothing from the checkout is ever published; only the report text is.
- A run whose report was written by tampering with `HEAD` (checkout moved) is still reverted; the report is kept, since it is text.

## 6. Vendored skill

`harness/debug/systematic-debugging/` is a copy of the superpowers `systematic-debugging` skill (SKILL.md plus `root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md`), MIT, with `harness/debug/LICENSE-superpowers` and `NOTICE`. It was copied unmodified so the adaptation diff is visible. The adaptation, done as a task:

- Remove everything that proposes, writes or tests a **fix** (Phases 3–4 become "state the verified root cause and the smallest fix as text"), the "ask your human partner" escalation, and the "3 failed fixes → question architecture" step. Nothing in it may prompt the agent to edit the project.
- Keep: the Iron Law reframed as "no conclusion without evidence", Phase 1 (read errors, reproduce, check recent changes, trace data flow), Phase 2 (patterns), and hypothesis-and-falsify from Phase 3 using read-only experiments.
- Read-only experiments are allowed: run a test, a script, a query, `git log`/`blame`/`bisect --no-checkout`. Anything that needs a write is reported as `HUMAN_INPUT_NEEDED`.
- `debug-prompt.md` references the adapted files; `debug-run.mjs` inlines `SKILL.md` into the prompt and tells the agent the reference docs' paths.
- No project or personal names anywhere in `harness/` (harness stays generic).

## 7. Report and publishing

The agent writes the report to the report path, fields at line start:

```
STATUS: FINDINGS | INCONCLUSIVE | BLOCKED
ISSUE: #<n>
INVESTIGATED_SHA: <sha of the investigated checkout, per repository when a target is used>
PROBLEM:
<restated symptom, expected vs observed>
REPRODUCTION:
<CONFIRMED | NOT_REPRODUCED | NOT_ATTEMPTED> + steps and output
EVIDENCE:
<commands, outputs, file:line references>
HYPOTHESES:
1. <statement> — CONFIRMED | INFERENCE | UNKNOWN — <why>
ROOT_CAUSE:
<verified cause, or None>
OWNING_MODULE:
<path or None>
NEXT_ACTION:
<smallest recommended step, as text>
UNKNOWNS:
<text, or None>
HUMAN_INPUT_NEEDED:
<text, or None>
```

- `FINDINGS` requires `ROOT_CAUSE` ≠ `None` and at least one `CONFIRMED` hypothesis; otherwise the harness downgrades it to `INCONCLUSIVE` with a warning (a root cause without confirmed evidence is not a finding).
- A missing report, missing field or unknown `STATUS` → `BLOCKED (agent)` with the parse error.
- Timeout or agent failure with a report present → published as `INCONCLUSIVE` plus a warning; without a report → `BLOCKED (agent)`.
- Publishing: one comment on the issue, carrying a `<!-- agent-debug -->` marker, the report rendered as sections, then any warnings. Over 60,000 characters the evidence is truncated and the full text stays in the run artifact. Labels: `agent:debug-done` on FINDINGS/INCONCLUSIVE, `agent:blocked` on BLOCKED; the `debug` label is removed so a re-add re-queues. The issue is **not** closed.
- The run artifact (logs, `prompt.md`, `report.md`) is kept as today. Consumers whose repositories are public should know artifacts are downloadable by any signed-in user (existing note in the README).

## 8. Workflow changes (manual — `.github/**` is protected)

- `templates/agent.yml`: the job `if` also accepts `github.event.label.name == 'debug'`, and passes `mode: debug` when it is.
- `run-task.yml` (reusable): `mode` input (default `implement`); in `debug` mode select picks the oldest `debug` issue, run calls `debug-run.mjs`, publish posts the §7 comment and skips the PR/branch steps.
- `templates/agent-task.md` is joined by `templates/debug-task.md` (symptom + `context:` line).
- `bootstrap.mjs` creates the `debug` and `agent:debug-done` labels.

## 9. Structure and reuse

- New: `harness/debug-run.mjs`, `harness/debug-prompt.md`, `harness/lib/debug.mjs` (issue parse, report parse/validate, comment render, read-only guard), `harness/debug/` (§6).
- Reused unchanged: `lib/config.mjs` (extended with `debug`), `lib/agent.mjs`, `lib/run-cmd.mjs`, `lib/target-run.mjs`, the probe and usage-limit handling.
- `run-task.mjs` is not modified. Another mode later (brainstorm) is a new prompt plus a report validator over the same runner.

## 10. Tests

Neutral fixtures (`o/repo`, `packages/core`); the agent is replaced via `AGENT_CMD`.

- Issue parsing: with and without `context:`; escaping path; missing file.
- Read-only guard: stub that edits a tracked file, adds an untracked file, commits, switches branch → all reverted, warning present, report still published.
- Report validation: all fields present → ok; missing field → BLOCKED; `FINDINGS` without confirmed hypothesis → INCONCLUSIVE.
- Timeout with and without a report.
- Comment rendering: marker present, truncation at the limit, warnings appended.
- Config: `debug` block defaults and rejection of bad values.
- Regression: a consumer without `debug` config and labels runs the existing flow unchanged (existing suite stays green).

## 11. Out of scope

Brainstorm mode, proposing or applying fixes, interactive questions, two-way context sync, writing back into any context folder, running a debug task from the Actions UI without an issue.
