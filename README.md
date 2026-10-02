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
