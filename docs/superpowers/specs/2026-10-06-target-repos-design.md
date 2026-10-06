# Target repositories — design

_2026-10-06. Extends `2026-10-02-agent-harness-design.md` (§5 config, §6 run flow, §9 security) and `2026-10-02-setup-and-artifacts-design.md`._

## 1. Purpose

Let a task change code in a repository other than the one that queues it. The queue (task issues, plans, `agent.config.json`, workflows) stays in a repository the author owns, the **consumer**; the code change lands as draft PRs in a **target** repository and its submodules, which carry no harness files at all.

The motivating case: a work superproject with two private submodules, which may not contain personal tooling, queued from a private repository the author owns that already clones the superproject in CI. Nothing here knows about that project: the harness clones the repository the config names and follows its `.gitmodules`.

Success: a consumer adds `"target"` to `agent.config.json` and two secrets; a `READY_FOR_QA` task yields one draft PR per changed repository (submodules and superproject), with branch names and PR text the consumer chooses, and the task issue records where they are. **A consumer that does not set `"target"` behaves exactly as today** (§10).

## 2. Configuration

One optional field in `agent.config.json`:

```json
{
  "target": {
    "repo": "owner/superproject",
    "path": "target",
    "branch": "fix/{slug}",
    "pr": { "title": "{taskTitle}", "body": ".github/agent-pr-body.md" },
    "author": { "name": "Jane Doe", "email": "jane@example.com" }
  }
}
```

- **`repo`** (required) — `owner/name` of the superproject.
- **`path`** (required) — where it is cloned, relative to the consumer root. Must be relative, no `..`, and ignored by the consumer's `.gitignore`; otherwise the run ends `BLOCKED (harness): target path "<p>" is not git-ignored`. This keeps the consumer's own diff free of target files.
- **`branch`** — branch-name template. Variables: `{slug}` (task title, lowercased, non-alphanumerics → `-`, trimmed to 50 chars), `{issue}`, `{task}`. The result must match `^[a-z0-9][a-z0-9._/-]{0,99}$`, else BLOCKED (harness). Default `agent/issue-{issue}`. The same name is used in every changed repository.
- **`pr.title`** — template; adds `{taskTitle}`. Default `Task {task}: {taskTitle}` (today's).
- **`pr.body`** — path in the consumer repo to a Markdown template. Variables: `{summary}` (the report's SUMMARY), `{changedFiles}` (list for that repo), `{checks}` (one line per check), `{related}` (links to the other PRs of the same task). Default: today's body **without** the `agent-task` marker or `Closes #n` line, since they point at the consumer.
- **`author`** — commit identity for the agent's commits in target repos. Default today's `agent-harness` identity.
- Submodules are discovered from the superproject's `.gitmodules` (`https://github.com/<owner>/<name>.git` URLs only; anything else ends BLOCKED (harness) naming the URL). No per-submodule config.

New optional secrets on `run-task.yml` (callers that don't pass them are unaffected):

- **`TARGET_READ_TOKEN`** — clones the superproject and submodules in the run job (§6). Read access suffices.
- **`TARGET_PUSH_TOKEN`** — pushes branches and opens PRs in the publish job; reads PR state in the select job. Needs write on every target repository. May be the same token as `TARGET_READ_TOKEN`; keeping them separate lets a consumer narrow the run job's token later.

`target` set without both secrets → BLOCKED (harness): `target configured but TARGET_*_TOKEN secret missing`.

## 3. Repositories under work

A run with a target works on an ordered list of repositories, each with its own `baseSha`, branch and diff:

1. each submodule that is checked out, deepest path first;
2. the superproject;
3. the consumer itself (today's single repository).

The consumer stays in the list so a task may also change it, e.g. add a regression test that lives in the consumer. Its branch stays `agent/issue-<n>` and its PR, when it has commits, is published exactly as today (marker, `Closes #n`).

## 4. Run flow changes

Today: checkout consumer → install → setup → baseline → agent → clean + reinstall → setup → verify → gate → bundle. With a target, changes in **bold**:

1. checkout consumer at base (unchanged)
2. **checkout target** (workflow step, §6): clone `repo` into `path` at the target base (§7), `submodules: recursive`, `fetch-depth: 0`, `persist-credentials: false`
3. **create the task branch in every repository under work** at its checked-out HEAD; set `author` in the target repos
4. install → setup → baseline (unchanged; checks may `cd` into `path`)
5. agent — prompt gains a target section (§5)
6. clean + reinstall + setup — **the clean also runs in each target repo** (`git clean -ffdX`)
7. verify → collect artifacts (unchanged)
8. **gate over the combined diff** (below)
9. **bundle each repository with commits** to `<out>/bundles/<owner>__<name>.bundle`; write `<out>/targets.json`: `[{repo, path, branch, base, baseSha, commits}]`. The consumer keeps `branch.bundle` as today.

Gate (`gate.mjs`) is unchanged in logic; its inputs become combined:

- `commits` = sum over repositories.
- `diff` = every repository's diff with paths prefixed by the repository's path from the consumer root (e.g. `target/server/ee/x.ts`), so `CHANGED_FILES`, conformance and plan file lists all use consumer-relative paths.
- Protected paths: the config's list, plus `.github/**` **inside each target repository** (`target/.github/**`, `target/server/ee/.github/**`).
- `testGlobs` match against the prefixed paths, so existing test deletions in target repos block as today.
- New block: a submodule has commits but the superproject's commit does not move its pointer to the submodule branch tip → `BLOCKED (gate): submodule <path> changed but the superproject does not point at it`. Without this the superproject PR would build against the old submodule.
- The agent left a target repo on another branch → BLOCKED (gate), as for the consumer today.

`verdict.json` gains `targets` (the `targets.json` content). It is absent without a target.

## 5. Agent prompt

Appended only when `target` is set:

- The code to change is in `{{TARGET_PATH}}`, a clone of `{{TARGET_REPO}}` with submodules. Each repository already has branch `{{TARGET_BRANCH}}` checked out; stay on it.
- Commit inside a submodule first, then commit in the superproject so its pointer includes the submodule commit.
- Commit in the consumer only what the task asks for there.
- Do not push, do not change remotes.

## 6. Workflow changes (`run-task.yml`)

- **select** — (a) close-on-merge sweep (§8); (b) target stacking base (§7). Both use `TARGET_PUSH_TOKEN`; this job runs no agent.
- **run** — new step before "Run task", only when the default-branch config has `target`: a `node cli.mjs target-info` step reads it, then a clone step runs with `TARGET_READ_TOKEN` in that step's environment only. The token is never written to disk (`persist-credentials: false`) and is not in the agent's environment allowlist. New "Bundle" logic per §4.9.
- **publish** — per §8.
- `agent.yml` template: two commented-out secret lines; no other change.

Trade-off, stated plainly: today the run job holds no GitHub token at all. With a target it holds a read token for the duration of one clone step on the agent's VM. GitHub masks it and the agent's process never receives it, but the "no token on the agent's machine" property becomes "no token in the agent's environment or on disk". A read-only `TARGET_READ_TOKEN` limits the damage if that assumption fails.

## 7. Stacking

Today a task bases on the open `agent/issue-<n>` PR of the highest earlier task in the same plan. With a target:

- The parent is the highest earlier task of the same plan whose issue is open, labelled `agent:ready`, and has a targets marker (§8) in its latest READY comment.
- The superproject is cloned at the parent's superproject branch, else the target's default branch. Submodules are then at the commits that branch pins, which are the parent's submodule branch tips; the task branch is created there.
- `base` per repository (the PR base) = the parent's branch in that repository if the parent changed it, else that repository's default branch.
- Branch names from the marker are re-validated against the §2 pattern before use, since the comment reaches shell steps.
- An upstream blocked task skips later tasks as today.

## 8. Publish

READY_FOR_QA with a target:

1. Push each repository's bundle in §3 order (submodules, then superproject) with `TARGET_PUSH_TOKEN`, from a fresh empty repository with hooks disabled, as today. `--force` only to a branch whose name came from this run's template.
2. Open a **draft** PR per pushed repository (`gh pr create --draft`), or update the open one for that head. Base per §7. Title and body from §2 templates; `{related}` lists the other PRs, filled in a second pass once all exist.
3. Consumer commits, if any, published exactly as today.
4. Issue comment: today's READY line, then one line per PR, then the **targets marker**:
   `<!-- agent-targets {"prs":[{"repo":"owner/sub","number":45,"branch":"fix/x","base":"main"},…]} -->`
   The marker is the only link from the queue to the target PRs; nothing in the target repos points back.
5. A push or PR failure in any repository → BLOCKED (harness) naming the step and repository; PRs already opened stay and are listed in the comment.

BLOCKED with a target: **nothing is pushed to target repos** (unlike today's push-for-inspection); the bundles stay in the run artifact for 14 days.

**Close-on-merge** (select job, every queue run and scheduled run): for each open issue labelled `agent:ready` whose latest READY comment has a targets marker, if the superproject PR in it is merged, close the issue as completed. `close-merged.yml` cannot do this because the merge event happens in the target repository.

## 9. Error handling summary

| Case | Result |
|---|---|
| target path not git-ignored, bad `.gitmodules` URL, bad branch template, missing secret | BLOCKED (harness), before the agent runs |
| clone fails (token, network) | BLOCKED (harness): `target checkout failed` |
| submodule changed, pointer not moved | BLOCKED (gate) |
| protected path / deleted test inside a target | BLOCKED (gate), as today |
| push or PR create fails | BLOCKED (harness), partial PRs listed |

## 10. Compatibility

Existing consumers (no `target`) must not change behaviour.

- Every new behaviour is gated on `config.target`. Without it: one repository, branch `agent/issue-<n>`, today's PR title, body, marker, `Closes #n`, push-on-BLOCKED, `close-merged.yml` — code paths unchanged.
- New workflow secrets are optional; new steps are skipped when `target` is absent. Callers' `agent.yml` needs no edit.
- `verdict.json` only gains fields (`targets`), never renames or drops one, so readers (Morning, agent-memory) keep working.
- **Release:** built on a branch and tagged `v2`. `v1` stays at `d969ea7` until v2 has run real tasks: first in the target consumer, then one smoke task in an existing consumer pinned to `@v2`. Moving `v1` is a separate decision.
- **Proof:** the existing test suite passes with no edits to existing tests. A new test runs the full fake-agent pipeline with a target-less config and asserts the verdict, branch, bundle, PR title and body equal today's output.

## 11. Testing

`node:test`, no network, existing fake-agent style:

- Config: `target` validation (types, relative path, template variables and pattern, missing secrets).
- Fixture: a local bare superproject with one submodule (`file://` remotes; `.gitmodules` URL rewrite via `GIT_CONFIG_*` env in tests only).
- Fake agents: commits in submodule + superproject pointer (READY); submodule commit without pointer (BLOCKED gate); edit to `target/.github/x` (BLOCKED gate); deletes a target test (BLOCKED gate); commits in consumer only (consumer PR only).
- Publish with the `gh` stub: push order, draft flag, `{related}` second pass, marker JSON, nothing pushed on BLOCKED, partial failure listing.
- Queue: stacking base from a parent's marker; malicious branch in marker rejected; close-on-merge sweep.
- Compatibility test from §10.

## 12. Out of scope

- `merge-stack.mjs` for target PRs (merge them by hand or with the target project's own tooling).
- Non-GitHub or non-HTTPS submodule URLs; nested submodules beyond what `--recursive` checks out.
- Multiple unrelated target repositories per consumer.
- Morning reading the targets marker: a separate change in the Morning repo, against the §8 marker contract.

## 13. Open questions

- Branch prefix per task (`fix/` vs `feat/`): one template per consumer, or let a plan task heading override it (e.g. `## Task 3: feat: …`)?
- Whether READY_FOR_QA should also require the target project's own CI on the draft PRs, or leave that to review.
