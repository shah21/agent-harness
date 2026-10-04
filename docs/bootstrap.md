# Connecting a project to the harness

The quick way:

    node harness/bootstrap.mjs --repo owner/name --project /path/to/project

It writes `.github/workflows/agent.yml`, `.github/workflows/close-merged.yml`, the issue template and
`agent.config.json` (derived from `package.json` scripts and the lockfile; existing files are left alone
unless `--force`), creates the six `agent*` labels, lets Actions create pull requests, asks for the
Claude token (`gh` prompts; it never passes through the script), then installs and runs every check in a
**fresh clone** of the committed code. It does not commit or push. `--dry-run` shows what it would do.

Then commit and push the new files, and queue a task: an issue whose body is `plan: <path>` and
`task: <n>`, labelled `agent`.

## What goes wrong on a first task, and what the script checks

Each of these has blocked a real first task. The script reports the first three before anything runs, and
the fresh-clone step catches the rest of the family.

- **A check passes locally but fails in the harness's checkout.** Generated or ignored files (Next.js route
  types, build output, a local `.env`) exist on your machine and not in a fresh clone, so the base is "red"
  and every task is blocked. Make each check self-sufficient: for Next.js, `typecheck` should be
  `next typegen && tsc --noEmit`. The fresh-clone step runs the checks the way the harness will.
- **`.gitignore` swallows a new file.** A scaffolded `.env*` rule also ignores `.env.example`, so the agent
  creates it and it never reaches the commit. Add `!.env.example` after the rule.
- **Vercel builds every agent branch.** Each task pushes a branch, and each push builds a preview. In
  `vercel.json`, set `git.deploymentEnabled` for `agent/*` to `false` and add an `ignoreCommand`
  (for example `[ "$VERCEL_GIT_COMMIT_REF" != "main" ]`) as a fallback.
- **The build needs environment variables.** Put non-secret placeholders in the `env` block of
  `agent.config.json`; never real secrets, the file is committed.
- **Actions cannot open PRs.** The API ignores form-encoded booleans, so
  `gh api -X PUT .../actions/permissions/workflow -F can_approve_pull_request_reviews=true` appears to
  succeed and changes nothing. The script sends a JSON body and keeps the default permissions.

Merging a stack of PRs afterwards: see "Merging stacked PRs" in the README.
