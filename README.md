# agent-harness

Runs one pre-planned coding task per GitHub Actions run with Claude Code, re-verifies the result itself, and hands back a PR (`READY_FOR_QA`) or an issue comment (`BLOCKED`). Never merges, never deploys.

Design: `docs/superpowers/specs/2026-10-02-agent-harness-design.md`

## Add to a project

Quickest: `node harness/bootstrap.mjs --repo owner/name --project <dir>` does steps 1 to 5 and the verification in step 6 (details and the mistakes it checks for: `docs/bootstrap.md`). By hand:

1. Copy `templates/agent.yml` to `.github/workflows/agent.yml`; replace `OWNER`.
2. Copy `templates/agent.config.json` to the repo root; adjust commands. Add `"env": { "NAME": "value" }` for non-secret values the build or tests need (for example a placeholder `DATABASE_URL`); it is committed, so never put real secrets there.
3. Copy `templates/agent-task.md` to `.github/ISSUE_TEMPLATE/agent-task.md`.
   Also copy `templates/close-merged.yml` to `.github/workflows/close-merged.yml` (replace `OWNER`): it closes a task's issue when its agent PR is merged, even a stacked one.
4. `claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>`.
5. Settings → Actions → General → enable *Allow GitHub Actions to create and approve pull requests*.
6. Make sure every check passes on the default branch (a red base blocks every task).

## Use

Open an issue whose body is `plan: <path>` and `task: <n>`, then add the `agent` label (`agent:opus` too for hard tasks). Label several before bed; they run one at a time, ordered by plan then task, and dependent tasks stack on each other's PRs. Retry a blocked task by removing `agent:blocked` and adding `agent`.

### Merging stacked PRs

A stacked PR targets the previous task's branch, not the default branch, and two GitHub behaviours follow from that:

- `Closes #n` closes the issue only when the PR is merged into the default branch. With `close-merged.yml` installed (see "Add to a project") the issue is closed when the PR merges whatever its base; without it, merging a PR into its parent branch leaves its issue open.
- Deleting a merged branch auto-closes any PR that targets it (the PR cannot be reopened; open a new one from the same branch).

Merge bottom-up: merge the lowest PR, retarget the next one to the default branch (`gh pr edit <n> --base main`), merge it, and repeat up the stack. Delete the branches only after the whole stack is merged, so don't use "delete branch on merge" or `gh pr merge --delete-branch` until then.

`harness/merge-stack.mjs` does exactly this with `gh`:

    node harness/merge-stack.mjs --repo owner/name          # lists the order, changes nothing
    node harness/merge-stack.mjs --repo owner/name --yes    # merges

It finds open `agent/issue-<n>` PRs by their marker, orders each plan's PRs by task, retargets each one to the default branch just before merging it, waits for GitHub to compute mergeability and for checks, and deletes the branches only after the last merge. It stops at the first draft, conflict or failing check, leaving earlier merges in place and deleting nothing.

## Services and artifacts

Checks that need running services (a database, a browser) get them from an optional `setup` command, run after install, before the baseline checks, and again before the harness's own verification — so it must be safe to run twice. Processes it leaves running in the background (containers, a database, a server) keep running for the checks. A failing or timed-out setup blocks the run as a harness problem. Default timeout `timeouts.setup`: `5m`.

`artifacts` lists globs (relative to the project root) whose files are copied into the run artifact after the harness's verification checks (or after a red baseline): test reports, screenshots, traces. Caps: 50 MB and 2,000 files. Symlinks, `.git` and `node_modules` are skipped. Artifacts of public repositories are downloadable by any signed-in GitHub user, so never collect anything secret.

```json
{
  "install": "pnpm install --frozen-lockfile",
  "setup": "docker compose -f docker-compose.test.yml up -d --wait && pnpm db:push:test",
  "checks": { "test": "pnpm test", "e2e": "pnpm exec playwright test" },
  "artifacts": ["playwright-report/**", "test-results/**"]
}
```

## Target repositories

A task can change a repository other than the one that queues it — for example a superproject with private submodules that must not contain harness files. Add `target` to `agent.config.json`:

```json
{
  "target": {
    "repo": "owner/superproject",
    "path": "target",
    "branch": "{type}/{slug}",
    "pr": { "title": "{taskTitle}", "body": ".github/agent-pr-body.md" },
    "author": { "name": "Jane Doe", "email": "jane@example.com" }
  }
}
```

- `path` must be git-ignored in the consumer (`target/` in `.gitignore`). Checks run from the consumer root and can `cd` into it. Set `testGlobs` to include target tests, e.g. `"target/**/*.spec.ts"`.
- `branch` variables: `{type}` (from a `feat:`/`fix:`/`chore:`/`refactor:`/`test:`/`docs:`/`perf:` prefix of the task title, default `fix`), `{slug}`, `{issue}`, `{task}`.
- PR template variables: `{taskTitle}`, `{task}`, `{issue}`, `{summary}`, `{changedFiles}`, `{checks}`, `{related}`. The default body has no link back to the consumer.
- Secrets: `TARGET_READ_TOKEN` (clones the superproject and submodules) and `TARGET_PUSH_TOKEN` (pushes branches, opens draft PRs, checks merges); uncomment both lines in `agent.yml`. They may be the same token.

Each changed repository gets a **draft** PR with the same branch name; submodules are pushed before the superproject, which must point at the submodule commits. The task issue's READY comment lists the PRs and carries an `agent-targets` marker: later tasks of the same plan stack on those branches, and the issue closes when the superproject PR merges. A BLOCKED task pushes nothing to target repositories; its bundles stay in the run artifact for 14 days.

The run job holds `TARGET_READ_TOKEN` during one clone step (masked, never written to disk, never in the agent's environment); prefer a read-only token there.

## Usage limits and a second account

Before any work, each run tries every configured account with one cheap turn. If an account runs out of usage mid-task, the attempt is discarded and the task restarts on the next account. Set the optional secret `CLAUDE_CODE_OAUTH_TOKEN_2` to add a second account. When every account is out, the issue is labelled `agent:waiting`, the queue pauses, and the scheduled trigger in `agent.yml` resumes it.

## Known limitation

PRs opened with `GITHUB_TOKEN` do not trigger the project's other workflows.

## Develop

`npm test` runs unit and fake-agent pipeline tests (Node ≥ 22, no dependencies).
