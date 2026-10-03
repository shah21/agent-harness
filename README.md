# agent-harness

Runs one pre-planned coding task per GitHub Actions run with Claude Code, re-verifies the result itself, and hands back a PR (`READY_FOR_QA`) or an issue comment (`BLOCKED`). Never merges, never deploys.

Design: `docs/superpowers/specs/2026-10-02-agent-harness-design.md`

## Add to a project

1. Copy `templates/agent.yml` to `.github/workflows/agent.yml`; replace `OWNER`.
2. Copy `templates/agent.config.json` to the repo root; adjust commands. Add `"env": { "NAME": "value" }` for non-secret values the build or tests need (for example a placeholder `DATABASE_URL`); it is committed, so never put real secrets there.
3. Copy `templates/agent-task.md` to `.github/ISSUE_TEMPLATE/agent-task.md`.
4. `claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>`.
5. Settings → Actions → General → enable *Allow GitHub Actions to create and approve pull requests*.
6. Make sure every check passes on the default branch (a red base blocks every task).

## Use

Open an issue whose body is `plan: <path>` and `task: <n>`, then add the `agent` label (`agent:opus` too for hard tasks). Label several before bed; they run one at a time, ordered by plan then task, and dependent tasks stack on each other's PRs. Retry a blocked task by removing `agent:blocked` and adding `agent`.

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

## Usage limits and a second account

Before any work, each run tries every configured account with one cheap turn. If an account runs out of usage mid-task, the attempt is discarded and the task restarts on the next account. Set the optional secret `CLAUDE_CODE_OAUTH_TOKEN_2` to add a second account. When every account is out, the issue is labelled `agent:waiting`, the queue pauses, and the scheduled trigger in `agent.yml` resumes it.

## Known limitation

PRs opened with `GITHUB_TOKEN` do not trigger the project's other workflows.

## Develop

`npm test` runs unit and fake-agent pipeline tests (Node ≥ 22, no dependencies).
