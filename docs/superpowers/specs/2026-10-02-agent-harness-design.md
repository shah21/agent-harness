# Agent Harness — Design

**Status:** Draft for review
**Date:** 2026-10-02
**First consumer:** SwingX (cricket draft game)

## 1. Purpose

A personal, reusable harness that executes pre-planned coding tasks unattended — overnight, while the author and their Mac sleep — and hands back either a pull request with verified evidence or a clear explanation of why it stopped.

```
Evening:  label task issues "agent"
Night:    harness → Claude Code → harness re-runs checks → gate
Morning:  PR per task (READY_FOR_QA)  or  issue comment (BLOCKED)
```

Built on these principles:

- **Correctness over completion.** `BLOCKED` is a valid, successful outcome.
- **Deterministic checks are authoritative.** The harness re-runs every check itself; Claude's report is a claim, not evidence.
- **No auto-merge, no deploy.** The PR is the handoff to human review.
- **Everything must earn its way in.** v1 is deliberately small.

## 2. Scope

### In scope (v1)

- A standalone `agent-harness` repository exposing a GitHub Actions reusable workflow.
- Input: a GitHub issue that references one task in a plan file committed to the project repo.
- One task per run; queued tasks run one at a time; dependent tasks stack.
- Fixed report format, deterministic gate, PR or issue comment as output.
- Tests for the harness itself (unit, fake-agent pipeline, real sandbox run).

### Non-goals (v1)

- Turning specs into plans. The human does this interactively with Claude (brainstorm → spec → plan) before anything runs unattended.
- Inline specs in issues.
- Multi-model routing, automatic escalation, AI reviewer stage.
- Automatic retries.
- Docker sandbox runner (see §11).
- Metrics dashboards.

## 3. Repositories and ownership

All work artefacts live in the **project** repo. The harness repo holds only machinery and knows nothing about any specific project.

| Lives in project repo (e.g. SwingX) | Lives in `agent-harness` |
|---|---|
| Specs and plans (`docs/superpowers/...`) | `.github/workflows/run-task.yml` (reusable, `on: workflow_call`) |
| Task issues, labels, comments | `harness/run.sh` (thin orchestrator) |
| Agent branches and PRs | `harness/lib/` (Node, zero dependencies: issue parsing, report parsing, gate) |
| `agent.config.json` | `harness/prompt.md` (fixed agent instructions) |
| `.github/workflows/agent.yml` (caller, ~20 lines) | `templates/` (caller workflow, config, issue template) |
| Secret `CLAUDE_CODE_OAUTH_TOKEN` | Its own CI (unit + fake-agent tests) |

The harness repo is **public** (it contains no secrets), so callers need no extra access setup. Projects pin a tag (`@v1`); the tag moves only after the harness passes all three test layers (§10).

## 4. Input: task issues

An issue body must contain:

```
plan: docs/superpowers/plans/2026-09-26-cricket-draft-mvp.md
task: 3
```

Validation, before any agent work:

- `plan` file exists on the base branch.
- The plan contains a heading matching `## Task 3:` (format used by the writing-plans skill).
- Otherwise → `BLOCKED: bad task reference`.

**Task sizing rule** (guideline for plan authors, not enforced): a task should be roughly ≤30 minutes of agent work, touch a handful of files, and include its own verification steps. A task that hits the Claude timeout is treated as a sign it was sized too large.

### Labels (state machine)

| Label | Meaning | Set by |
|---|---|---|
| `agent` | Queued for execution | Human |
| `agent:opus` | Use Opus instead of the default model | Human (optional) |
| `agent:running` | A run is working on it | Harness |
| `agent:ready` | Ended `READY_FOR_QA`; PR open | Harness |
| `agent:blocked` | Ended `BLOCKED`; see comment | Harness |

Re-running a task = remove the outcome label, re-add `agent`.

## 5. Project configuration: `agent.config.json`

JSON rather than YAML so the harness needs no parser dependency.

```json
{
  "install": "pnpm install --frozen-lockfile",
  "checks": {
    "test": "pnpm test",
    "lint": "pnpm lint",
    "typecheck": "pnpm exec tsc --noEmit",
    "build": "pnpm build"
  },
  "model": "sonnet",
  "maxTurns": 150,
  "timeouts": { "install": "15m", "claude": "45m", "check": "10m" },
  "protectedPaths": [".github/**", "agent.config.json"],
  "testGlobs": ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "e2e/**"]
}
```

Only `install` and `checks` are required; the rest have the defaults shown. `.github/**` and `agent.config.json` are always protected, even if omitted.

Optional `setup` (command) and `artifacts` (globs), plus `timeouts.setup`, are specified in `2026-10-02-setup-and-artifacts-design.md`.

## 6. Run flow

The caller workflow triggers on `issues: labeled` (label `agent`) and on `workflow_dispatch`. Each run processes **exactly one** task: the oldest queued issue, ordered by plan then task number.

**Queueing.** GitHub's `concurrency` group keeps one running and one pending run, discarding older pending runs. So the harness does not rely on one-run-per-label: every run picks the next queued issue itself, and after finishing re-dispatches the workflow (`workflow_dispatch`, permitted with `GITHUB_TOKEN`) if any `agent` issues remain. Discarded pending runs therefore lose nothing.

Steps (each with a timeout; any harness-step failure → `BLOCKED (harness)`):

1. **Pick and claim.** Select the next queued issue; swap `agent` → `agent:running`. If none, exit.
2. **Parse.** Validate the issue body (§4).
3. **Upstream check.** If an open issue for the same plan with a lower task number carries `agent:blocked` → `BLOCKED: upstream task N blocked`, skip.
4. **Choose base (stacking).** Base = head branch of the open agent PR for the same plan with the highest task number below this one; else the default branch. The PR targets that base, so its diff contains only this task.
5. **Prepare.** Checkout project at base with `persist-credentials: false`; create branch `agent/issue-<n>`; configure a git identity; run `install`. Then run `setup` if configured (again before step 8).
6. **Baseline.** Run all checks before Claude starts. Any failure → `BLOCKED: base is red` (names the failing check). Claude does not run.
7. **Agent.** Run Claude Code CLI headless:
   `timeout <claude> claude -p "<prompt.md + task reference + report path>" --model <model> --max-turns <maxTurns> --allowedTools "Read,Edit,Write,Glob,Grep,Bash"`
   with only `CLAUDE_CODE_OAUTH_TOKEN` provided. Claude reads the plan from disk, implements the task, commits locally, and writes the report to `$RUNNER_TEMP/agent/report.md` (outside the checkout, never committed).
8. **Verify.** The harness re-runs every check (each under the `check` timeout) and inspects the diff against the base.
9. **Gate.** Decide the outcome (§7).
10. **Publish.** Using `GITHUB_TOKEN` (never exposed to step 7):
    - `READY_FOR_QA` → push branch, open PR titled `Task <n>: <task title>` with report, real check results and `Closes #<issue>`; label `agent:ready`.
    - `BLOCKED` → comment with blocker, evidence, required action and run link; push the branch only if it has commits; label `agent:blocked`.
11. **Artifacts.** Always upload `report.md`, check logs, and the Claude transcript. Plus files matching the project's `artifacts` globs.
12. **Continue.** Re-dispatch if queued issues remain.

The `publish` job runs whenever an issue was selected, even if `run` failed or timed out, and `publish.sh` traps its own errors to still label and comment. **The author never wakes up to silence.**

### Agent prompt rules (`prompt.md`)

- Implement only the referenced task; no unrelated refactoring.
- Run the task's verification steps and the project checks before reporting.
- Wrap every test or build command in `timeout 600`; never start dev servers, watchers, or anything that does not exit.
- Never delete, skip or weaken tests; never edit protected paths.
- If the plan does not match the code, or the task cannot be done safely, stop and report `BLOCKED` with evidence instead of improvising.
- Commit work locally; do not push or open PRs.

## 7. Report and gate

### Report format (written by Claude)

```
STATUS: READY_FOR_QA | BLOCKED
TASK: plan=<path> task=<n> issue=#<n>
SUMMARY:
<2-5 lines>
CHANGED_FILES:
- <path>
CHECKS:
- <name>: PASS | FAIL | NOT_RUN
SELF_REVIEW:
<scope, tests added, risks>
KNOWN_ISSUES:
<text or None>
BLOCKER:                 # required when BLOCKED
EVIDENCE:                # required when BLOCKED
REQUIRED_HUMAN_ACTION:   # required when BLOCKED
```

### Gate decisions (evaluated in order; first match wins)

| # | Condition | Outcome |
|---|---|---|
| 1 | Claude timed out or exited non-zero | `BLOCKED (agent)` — reason: timeout / crash |
| 2 | Report missing, unparsable, or missing required fields | `BLOCKED (harness)` |
| 3 | Report says `BLOCKED` | `BLOCKED` with Claude's blocker |
| 4 | No commits on branch | `BLOCKED (gate)` — no changes |
| 5 | Diff touches a protected path | `BLOCKED (gate)` — lists paths |
| 6 | Diff deletes or renames an existing file matching `testGlobs` | `BLOCKED (gate)` |
| 7 | Any real check fails | `BLOCKED (gate)` — lists failures and any report/real mismatch |
| 8 | Otherwise | `READY_FOR_QA` |

Non-blocking warnings, included in the PR body: report `CHECKS` disagree with real results while all real checks pass; `CHANGED_FILES` differs from the actual diff; dependency manifest or lockfile changed.

## 8. Timeouts, models and limits

| Layer | Default | On hit |
|---|---|---|
| Job | 90 min | Killed; `always()` step comments `BLOCKED: job timeout` |
| Install | 15 min | `BLOCKED (harness)` |
| Claude | 45 min + `maxTurns` | Killed; commits kept and pushed for inspection; `BLOCKED (agent)` |
| Each check | 10 min | Check counts as FAIL |

- **Model:** `sonnet` by default (plans are authored by Opus and are detailed enough to execute); `agent:opus` label overrides per issue.
- **Concurrency:** group `agent-<repo>`, `cancel-in-progress: false` — one task at a time per project.
- **Usage:** each run consumes roughly 30–90 Actions minutes; private repos on GitHub Free have ~2,000/month. Measure after the first runs.

## 9. Security

The run is split into three jobs, each on its own fresh VM:

| Job | Token permissions | Does |
|---|---|---|
| `select` | `issues: write`, read otherwise | picks and claims the next issue |
| `run` | `contents: read` + `CLAUDE_CODE_OAUTH_TOKEN` | install, baseline, agent, verify, gate; uploads verdict, logs and a `git bundle` of the branch |
| `publish` | `contents`, `pull-requests`, `issues`, `actions: write` | fetches the bundle into a fresh repository and pushes with hooks disabled; opens the PR or comments |

- The agent never shares a machine with a write-capable token. On GitHub-hosted runners the agent has passwordless `sudo`, so isolation must come from separate VMs, not from environment filtering.
- Inside `run`, the agent process additionally receives only an allowlisted environment, and checkouts use `persist-credentials: false`.
- `publish` uses a harness checked out fresh at the pinned ref and treats the verdict as data. It uses the run's verdict only when the `run` job succeeded; otherwise it publishes a fallback `BLOCKED (harness)`.
- Protected paths prevent the agent from modifying CI or its own gate configuration through its commits.
- Only same-repository `agent/issue-<n>` PRs can become a stacking base; other PRs carrying a task marker are ignored.
- The caller workflow grants `contents: write`, `pull-requests: write`, `issues: write`, `actions: write`; each job narrows that to what it needs.

**Known limit.** Within the `run` VM, a deliberately adversarial agent (for example via prompt injection) with `sudo` could tamper with the harness process and forge a `READY_FOR_QA` verdict. The worst outcome is a PR that misstates its check results; it cannot obtain a write token, merge, or touch other repositories. The gate defends against mistakes and dishonest reports, not against an agent with root on its own VM. Re-running checks in a separate job would close this and is deferred until needed.

## 10. Testing the harness

1. **Unit (Node `node:test`, no Claude).** Fixture-driven tests for issue parsing, report parsing, base selection, and every row of the gate table.
2. **Pipeline with a fake agent (no Claude).** `run.sh` accepts `AGENT_CMD` to replace Claude with a scripted fake, run against a tiny fixture project in dry-run mode (no push). Scenarios: honest success; claims PASS but tests fail; deletes a test; edits `.github/`; hangs (timeout); writes no report; base already red; stacked task with blocked upstream.
3. **Real sandbox (manual, uses subscription).** A throwaway repo `agent-harness-sandbox` with a three-task plan, through the real GitHub workflow:
   - easy task → PR;
   - deliberately impossible task (needs a non-existent secret) → `BLOCKED` with clear comment;
   - task depending on the first → stacked PR.

Layers 1–2 run in the harness repo's CI on every push. The `v1` tag is created only after layer 3 passes.

## 11. Rollout

1. Build harness; layers 1–2 green.
2. Sandbox repo; layer 3 green; tag `v1`.
3. SwingX setup (author): push to GitHub; `gh secret set CLAUDE_CODE_OAUTH_TOKEN`; enable *Settings → Actions → Allow GitHub Actions to create and approve pull requests*; add `agent.config.json` and `agent.yml`; create labels.
4. First real night: one SwingX task, then two stacked tasks.

### Known limitation

PRs opened with `GITHUB_TOKEN` do not trigger other workflows in the project (e.g. a separate PR CI). Acceptable for v1 because the harness has already run the checks; a fine-grained PAT can replace it later.

## 12. Future (only when runs show the need)

- **Docker cloud sandbox runner.** Verified 2026-09-26: Claude subscription auth works in Docker cloud sandboxes after deleting the `apiKeyHelper: "echo proxy-managed"` line from `~/.claude/settings.json` and setting `CLAUDE_CODE_OAUTH_TOKEN`. Unofficial (Docker documents API keys only). Same `run.sh`, different launcher; removes the Actions-minutes cap.
- Escalation: retry a Sonnet `BLOCKED` once with Opus.
- Review stage: a model reviews the diff against the plan task before the gate.
- Planning run: inline spec issue → plan PR.
- Metrics: READY/BLOCKED rate, runtime, human rework per task.
