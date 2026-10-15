# Target Base Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task issue can name the target repository branch to start from with a `base: <branch>` line. The target is checked out at that branch (submodules at the commits it records), and the draft PRs open against it. Today a first task always starts from, and PRs into, the target's default branch, so fixes for a release branch cannot be queued.

**Architecture:** `harness/lib/issue.mjs` `parseTaskRef` reads an optional `base:` line. `harness/lib/queue.mjs` `selectNext` copies it into the selection as `targetBase`. `harness/cli.mjs` `target-info` uses it as the checkout ref when no stacked parent supplies one. `harness/run-task.mjs` passes it to `prepareTarget` (`harness/lib/target-run.mjs`) as the fallback PR base for every target repository. `harness/publish-targets.mjs` falls back to a repository's default branch when that repository has no branch of that name (a submodule that does not carry the release branch).

**Tech Stack:** Node ≥ 22, ES modules, `node:test`, bash. No dependencies.

**Spec:** none. Gap found in practice: release-branch bug fixes could not be queued because the code they change exists only on the release branch.

**Execution:** Task 1 runs as an agent task (label `agent`).

## Global Constraints

- No new dependencies. Existing tests are never edited; new cases go in a new file. `test/compat.test.mjs` must pass.
- **Compatibility:** an issue without a `base:` line gives byte-identical selections, verdicts, prompts and PRs to today. `parseTaskRef` returns `{ plan, task }` with no `base` key when the line is absent.
- **Stacking wins:** when a ready parent task of the same plan exists, its branches are the checkout ref and PR bases, as today. `base:` only fills repositories the parent did not supply.
- **Validation:** the branch must match `BRANCH_RE` from `harness/lib/target.mjs` and must not contain `..`, end with `/` or end with `.lock`. Error, verbatim: `base is not allowed: <value>` (returned as `parseTaskRef(...).error`, so the queue skips it as a bad task reference).
- **Needs a target:** `base:` without `target` in `agent.config.json` blocks the task: outcome `BLOCKED`, kind `gate`, reason verbatim `bad task reference: "base:" needs a "target" in agent.config.json`.
- **Generic:** no project, company or repository names in code, tests or docs. Fixtures use `o/super`, `o/sub`, branch `release/v2`.
- Commits: conventional messages, no trailers. Keep the test file small: one case per behaviour listed under Review Focus, nothing more.

## Review Focus

- **No `base:` line.** Expected: selection, checkout ref and PR bases unchanged. (Test `no base line changes nothing`.)
- **`base:` on a first task.** Expected: `targetBase` in the selection, `target-info` prints `ref=release/v2`, `prepareTarget` gives every repository `base: 'release/v2'`. (Test `base is the checkout ref and PR base`.)
- **`base:` on a stacked task.** Expected: the parent's branches win for the repositories the parent changed; others get `release/v2`. (Test `a stacked parent wins over base`.)
- **Submodule without the branch.** Expected: its PR opens against its default branch; the superproject PR still targets `release/v2`. (Test `missing base branch falls back to the default branch`.)
- **Bad values.** `base: ../x`, `base: Release/V2`, `base: x.lock`. Expected: `base is not allowed: …`. (Test `rejects unsafe base names`.)

---

## Task 1: feat: target base branch from the task issue

**Files:**
- Modify: `harness/lib/issue.mjs`
- Modify: `harness/lib/queue.mjs`
- Modify: `harness/cli.mjs`
- Modify: `harness/run-task.mjs`
- Modify: `harness/lib/target-run.mjs`
- Modify: `harness/publish-targets.mjs`
- Modify: `README.md`
- Modify: `test/stubs/gh`
- Test: `test/target-base.test.mjs`

**Interfaces:**
- Produces: `parseTaskRef(body)` → `{ plan, task }` or `{ plan, task, base }` or `{ error }`; `selectNext(...)` selections gain `targetBase` (only when the issue has `base:`); `prepareTarget({ ..., issueBase })` → each repo's `base` is `parentBases?.[repo] ?? issueBase ?? null`.

- [ ] **Step 1: Write the failing tests** — create `test/target-base.test.mjs` with the five cases named under Review Focus. Use `parseTaskRef` and `selectNext` directly; for `prepareTarget` use `makeTargetProject` from `test/helpers/target-fixture.mjs` with `ref` set to a branch you create in the fixture remotes; for publishing follow `test/publish-targets.test.mjs` (gh stub on `PATH`, `GH_LOG`). Teach `test/stubs/gh` one new case: `api` exits 1 when `$GH_MISSING_BRANCH_REPO` is set and the call's path starts with `repos/$GH_MISSING_BRANCH_REPO/branches/`, else exits 0 (today it already exits 0, so existing tests are unaffected). Run `node --test test/target-base.test.mjs`; expect failures.

- [ ] **Step 2: Parse `base:`** — in `harness/lib/issue.mjs` `parseTaskRef`, read `/^base:[ \t]*(\S+)[ \t]*$/m`. Validate as in Global Constraints (import `BRANCH_RE` from `./target.mjs`). Add `base` to the result only when present.

- [ ] **Step 3: Carry it through selection** — in `harness/lib/queue.mjs` `selectNext`, when `next.ref.base` is set, add `targetBase: next.ref.base` to the non-skip return. In `harness/cli.mjs` `target-info`, print `ref=${selection.targets?.superBranch ?? selection.targetBase ?? ''}`.

- [ ] **Step 4: Use it as PR base** — in `harness/run-task.mjs`, right after the target block is known: if `ref.base` is set and `config.target` is not, finish with the blocked reason from Global Constraints. Pass `issueBase: ref.base ?? null` to `prepareTarget`. In `harness/lib/target-run.mjs` `prepareTarget`, accept `issueBase` and set `base: parentBases?.[r.repo] ?? issueBase ?? null`. `harness/debug-run.mjs` keeps passing nothing.

- [ ] **Step 5: Fall back when a repository lacks the branch** — in `harness/publish-targets.mjs`, when `t.base` is set, check `gh api repos/<repo>/branches/<base>`; if it fails, use the repository's default branch (same lookup as today's `t.base === null` path). Record the base actually used in `opened` (it already is).

- [ ] **Step 6: Document** — in `README.md` "Use", after the `plan:`/`task:` sentence add: "With a `target` configured, an optional `base: <branch>` line starts the task from that branch of the target repository (submodules at the commits it records) and opens the PRs against it; a submodule without that branch gets a PR against its default branch. Stacked tasks still build on their parent's branches." In "Target repositories", add one bullet pointing to it.

- [ ] **Step 7: Verify** — `node --test test/target-base.test.mjs` passes; `npm test` passes, including `test/compat.test.mjs`. Commit: `feat: target base branch from the task issue`.
