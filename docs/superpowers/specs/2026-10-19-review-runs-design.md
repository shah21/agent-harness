# Review runs — design

_2026-10-19. Extends `2026-10-13-review-loop-design.md` (§12: project review skill, verify pass) and reuses the debug-run shape from `2026-10-09-debug-agent-design.md`._

## 1. Purpose

Review a pull request that already exists — written by a person or by the harness — with the project's own review skill, unattended, and put a short review into the issue that asked for it. Nothing is posted to the pull request, nothing is fixed, nothing is committed.

Success: labelling an issue `review` whose body names one or more pull requests yields, within the timeout, an issue body that ends with a brief review: a verdict line and one line per confirmed high or medium finding, each linked to the line at the pull request's head. **A consumer that never uses the label behaves exactly as today.**

## 2. Trigger and issue shape

- Label **`review`**. Only the repository owner's own label starts a run (as `debug`). Bootstrap creates `review` and `agent:review-done`.
- Body lines `pr: owner/repo#123` or `pr: https://github.com/owner/repo/pull/123`, one per repository (a change can span a superproject and its submodules). Optional `context: <path>`, a file on the default branch (as debug).
- A pull request must belong to the consumer repository, the configured target repository, or one of the target's submodules. Anything else is skipped as `bad issue`.
- Requires a `review` block with a `skill` in `agent.config.json` (§12 of the review-loop spec); without it the run ends `BLOCKED (gate)`.

## 3. Flow

New runner `harness/review-run.mjs` and reusable workflow `run-review.yml` (select → run → publish on three VMs, as debug). The caller template gains a `review` job after `debug`.

1. **Select** (issues: write; read tokens): pick the oldest open `review` issue not running; read each pull request (`headRefOid`, `baseRefName`, title, body, additions, deletions) with the consumer token or `TARGET_READ_TOKEN`. Find the harness task behind it: a task marker in the pull request body (consumer pull requests), or a queue issue whose READY comment's `agent-targets` marker lists it (target pull requests). More than 50,000 changed lines in total → skipped: too large.
2. **Run** (contents: read): check out the consumer and target as debug does (full history, submodules); then, in each pull request's repository, fetch and check out its head (detached) and record the merge base with its base branch. Tokens live only in those steps. Install and setup run, so the reviewer can execute tests. Then one review step: the skill copied at base, the unattended frame, read-only commands and subagents, anchored findings, the verify pass. No fixer.
3. **Publish** (issues: write): rewrite the issue body: everything above `<!-- agent-pr-review -->` is kept, everything below is replaced. Labels: `review` → `agent:review-done`. A blocked run gets `agent:blocked` and one comment with the reason; usage limits leave it queued (`WAITING`).

## 4. Reviewer input

- Plan goal and task section when the harness task was found (read from the default branch); otherwise none.
- Each pull request's title and description, as untrusted data.
- The optional `context:` file.
- Diff, changed hunks and nearest `AGENTS.md` / `CLAUDE.md` per pull request repository, from its merge base to its head.
- Tools `Read,Glob,Grep,Write,Bash,Agent,Task` (subagents for large changes; Claude Code has named that tool both ways). The review loop's reviewer and verifier get the same list.

## 5. Output

```markdown
<!-- agent-pr-review -->
## 🔴 Changes requested · 2 high · 1 medium
`o/super#12` @ a1b2c3d · `o/sub#3` @ d4e5f6a

- 🔴 [`src/app.ts:42`](https://github.com/o/super/blob/<head>/src/app.ts#L42) Problem sentence. **Fix:** fix sentence.
- 🟡 [`lib/x.ts:7`](…) Problem sentence. **Fix:** fix sentence.

<details><summary>3 low · 1 withdrawn</summary>
…
</details>

<sub>opus · [run](…)</sub>
```

- Verdict: any confirmed high → 🔴 Changes requested; else any confirmed medium → 🟡 Comments; else 🟢 Looks good.
- One line per confirmed high or medium finding; problem and fix each cut to 160 characters. Links point at the line in the pull request repository at its head SHA.
- Lows, withdrawn findings and run warnings only inside the folded block.
- The issue body is capped at 60,000 characters (the folded block is cut first).

## 6. Verdict

`{ mode: "review", outcome: "REVIEWED" | "BLOCKED" | "WAITING", kind, reasons, warnings, issue, issueTitle, model, prs: [{ repo, number, url, headSha, baseSha, prefix }], task, review: { verdict: "changes" | "comments" | "clean", findings } }`.

Blocked reasons, verbatim: `review runs need a "review" block with a "skill" in agent.config.json` (gate), `pull request checkout failed` (harness), `review skill not found: <dir>/SKILL.md` (agent), `invalid review: <error>` (agent), `review timed out` (agent).

## 7. Security

As debug runs: the agent's VM holds no write token; read tokens exist only in checkout steps, never on disk or in the agent's environment; the checkout is restored after every session; pull request text, plan text and context are untrusted data in the prompt. Head SHAs must be 40 hex characters and base branch names pass the branch-name check before they reach a shell.

## 8. Testing

`node:test`: issue parsing, selection, task lookup, checkout planning; the checkout script against local remotes; the runner with fake reviewer and verifier; rendering and body merging; the publish script with the `gh` stub. Task runs, review loops and debug runs keep their existing tests and goldens unchanged.

## 9. Out of scope

Posting to the pull request, fixing findings, triggering from a dashboard, reviewing more than one issue per chain.
