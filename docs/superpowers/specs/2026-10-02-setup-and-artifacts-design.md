# Project setup hook and run artifacts — design

_2026-10-02. Extends `2026-10-02-agent-harness-design.md` (§5 config, §6 run flow, §9 security)._

## 1. Purpose

Let a project verify work that needs running services — a database, a browser test suite — and keep the evidence when such a check fails. The motivating case is a browser end-to-end suite against a local database in Docker, but nothing here knows about Docker, databases or browsers: the harness runs a command the project supplies and copies files the project names.

Success: a project can add `"setup"` and `"artifacts"` to `agent.config.json`, and a red end-to-end check yields a `BLOCKED` run whose artifact contains the test report (screenshots, traces). Projects that set neither behave exactly as today.

## 2. Configuration

Two optional fields in `agent.config.json`, plus one timeout:

```json
{
  "install": "pnpm install --frozen-lockfile",
  "setup": "docker compose -f docker-compose.test.yml up -d --wait && pnpm db:push:test",
  "checks": { "test": "pnpm test", "e2e": "pnpm exec playwright test" },
  "artifacts": ["playwright-report/**", "test-results/**"],
  "timeouts": { "setup": "5m" }
}
```

- **`setup`** — a non-empty command string, or absent. Starts whatever the checks need. Must be idempotent: the harness runs it more than once per run (§3). Default timeout `timeouts.setup` = `5m`, parsed like the other durations.
- **`artifacts`** — an array of glob strings (the harness's existing `**`/`*`/`?` matcher), relative to the project root, or absent. Matching files are copied into the run artifact.
- Validation follows the existing style: wrong types fail config loading with a precise message, giving `BLOCKED (harness): invalid agent.config.json: …`. Globs must be relative: no leading `/`, no `..` segment.

## 3. Run flow changes

Current flow: install → baseline checks → agent → clean + reinstall → verify checks → gate. New flow, changes in **bold**:

1. install
2. **setup** (log `logs/setup.log`)
3. baseline checks
4. agent — prompt states that the project's services are already running
5. clean + reinstall
6. **setup again** (log `logs/setup-verify.log`) — the agent may have stopped or polluted services; re-running the idempotent command restores them before the authoritative checks
7. verify checks
8. **collect artifacts** (§4)
9. gate

- Setup runs with the same environment as install and checks: project `env` included, no Claude tokens.
- **Setup failure** (non-zero exit or timeout) ends the run `BLOCKED (harness)`: `setup failed (exit N)` / `setup timed out` — or, at step 6, `setup before verification failed (exit N)`. It is never attributed to the agent's code, matching how install failures are treated today.
- No teardown: the GitHub-hosted runner is discarded after the job.

## 4. Artifact collection

- Runs once: after the verify checks, or after the baseline checks when the base is red. Nothing is collected in any other case — including when the agent fails or times out, because files left at that point may have been written by the agent.
- The harness empties `<out>/artifacts` before copying, since the agent can write inside `<out>`.
- Because step 5 cleans the working tree, files written by the agent itself are gone before verify; what is collected was produced by the harness's own check run, not the agent.
- Walks the project tree, skipping `.git` and `node_modules`, and copies each file matching any glob to `<out>/artifacts/<same relative path>`. The workflow already uploads `<out>` as `agent-run-issue-<n>`, so the workflow does not change.
- **Caps:** at most 50 MB in total and 2,000 files. Beyond either cap, remaining files are skipped and `artifacts/TRUNCATED.txt` lists how many were skipped and why. Symlinks are not followed.
- Collection never changes the verdict: errors are written to `logs/artifacts.log` and the run continues.
- When anything was collected, the issue comment / PR body line linking the run log also says `artifacts collected (N files)`.

## 5. Agent prompt

One new rule, generic:

> Services started by the project's setup command are already running. Do not start dev servers or watchers yourself; a check command that starts and stops its own server (for example a test runner's web-server option) is fine.

This replaces the current "Never start dev servers…" line. When `setup` is absent, the first sentence is omitted.

## 6. Security

- Setup is project code run with the same environment as install and checks — no Claude tokens, no new secrets. It adds no capability the checks did not already have.
- Artifacts: collected after the clean (§4), so the agent cannot plant a file to have it uploaded, except through committed files, which already appear in the PR. Artifacts keep the run artifact's retention (14 days) and visibility (repository collaborators for private repos; signed-in users for public ones). The README tells public-repo users not to collect anything secret.

## 7. Testing

Test-first, in the existing suites (`npm test`, ~100 tests, fake agent):

- config: `setup` / `artifacts` / `timeouts.setup` accepted; wrong types, an empty command, absolute or `..` globs rejected; absent → today's behaviour.
- pipeline: setup runs before baseline and before verify (order visible in logs); setup failure and timeout at each point give the right `BLOCKED (harness)` reason; a project without `setup` runs no setup step.
- artifacts: files matching globs are copied with their relative paths; `.git`/`node_modules` skipped; caps produce `TRUNCATED.txt`; collected after a red baseline; collection errors don't change the verdict; nothing collected when no check phase ran.
- prompt: the rule text with and without `setup`.

Then `actionlint`, a run on `agent-harness-sandbox` with a trivial `setup` (`echo up > .setup-ran`) and an `artifacts` glob, then move the `v1` tag.

## 8. Rollout

Backward compatible: both fields optional, workflow untouched. Ships under the existing `v1` tag. README gains a short "Services and artifacts" section with the example above.

## 9. Non-goals

- Starting services itself (Docker, databases, browsers) — that is the project's `setup` command.
- Teardown hooks, per-check setup, or parallel checks.
- Uploading artifacts somewhere other than the existing run artifact, or attaching them to the PR.
