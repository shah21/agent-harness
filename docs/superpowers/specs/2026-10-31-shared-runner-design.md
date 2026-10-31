# Shared runner: one public repository runs the harness for many private projects

Status: draft for review. Nothing here is built.

## 1. Goal

Run the harness for any number of private projects from a single public repository, so the work costs no hosted-runner minutes, **and so that nothing about a project is readable in public except that a run happened, when it started and how long it took.**

"Nothing" includes: repository names, task titles, plan text, code, diffs, test output, agent output, and run artifacts.

Public repositories get free hosted-runner minutes; private ones draw from a quota. The Claude usage that the agent spends is a separate bill and is unchanged.

## 2. Decisions taken

| Question | Decision |
|---|---|
| What may be public? | Metadata only: a run exists, its time and duration. Everything else is hidden or encrypted. |
| How does work reach the runner? | A scheduled poll across the projects, plus a manual `workflow_dispatch` to start one now. No workflow in the project repositories. |
| Credentials | Fine-grained personal access tokens, one per repository owner, each limited to the named repositories. |
| Run output retention | Encrypted, 3 days. A trimmed record is kept in a private store for good. |
| Where does the project list live? | A file in a private repository, fetched at run time. Never committed to a public repository. |
| Parallelism | Up to 3 projects at once, at most one task per project. A project's own queue stays serial. |
| Rollout | One low-risk project first, then the others, the most sensitive last, once the leak tests pass. |

## 3. Non-goals

- Self-hosted runners, GitHub Apps, and instant label-triggered dispatch were considered and rejected for now (they bring back cost, need an org owner's approval, or put a workflow and a token in every project).
- Moving each project's own pull-request CI. Those checks still use the project repository's quota. Out of scope here.
- Changing how a task is planned, gated, verified or reviewed. The harness's behaviour per task is unchanged.

## 4. Architecture

Three repositories play different roles. None of the public ones names a project.

- **Harness** (public, existing): the code and the reusable workflows. Unchanged in role.
- **Runner** (public, new, neutral name): a thin caller workflow pinned to a harness tag, and the secrets. It holds no project names, no config and no plans.
- **Private store** (private, existing `agent-memory`): the project list, the trimmed run records, and the blocklist used by the leak tests.

Each project keeps its `agent.config.json`, its plans and its task issues in its own private repository. The runner reads them at run time from the project's default branch.

### 4.1 Flow

1. **select** (scheduled or manual). Reads the project list from the private store. For each project it lists the `agent`-labelled issues, keeps the existing order (plan, then task, with stacking) and picks the first runnable task. At most 3 projects are chosen. Selection is written to an **encrypted** artifact; the matrix handed to the next job holds only indices.
2. **run** (one parallel job per chosen project, read-only). Clones the project with that owner's read token, runs the gate, the agent, the harness's own re-verification and the optional review, exactly as today. After the agent has finished it **encrypts the whole output directory** and uploads it with 3-day retention. The agent step never sees the encryption key.
3. **publish** (write access). Decrypts, then posts the READY or BLOCKED comment and opens the PR in the **private** project repository, updates labels, closes issues whose PRs merged, and pushes a trimmed record to the private store.

### 4.2 Project list

Illustrative shape only (placeholders, not real names):

```json
{
  "projects": [
    { "repo": "owner/project-a", "tokenOwner": "owner" },
    { "repo": "org/project-b", "tokenOwner": "org", "target": true }
  ]
}
```

`tokenOwner` selects which secret to use. A project that needs a second repository (the existing `target` feature) keeps its own `target` block in its own `agent.config.json`.

## 5. Concurrency

- Up to 3 run jobs at once, from different projects. The cap is configurable.
- One task at a time within a project. Stacked tasks depend on their parent's branch, so a project never runs two tasks at once.
- A tick must not wait behind a long task, or one slow project would block every other. So the per-project lock is held per run job (a job-level concurrency group named by an opaque hash of the repository, never the repository name), not per workflow. The select step also skips a project whose previous run is still in progress. The exact lock mechanism is settled in the plan; the requirement is "no two runs of one project, no head-of-line blocking across projects".
- Parallel runs share the Claude token(s). The existing fallback to a second account and the `agent:waiting` pause on exhaustion apply unchanged.

## 6. What stays hidden, and how it is enforced

| Channel | Rule |
|---|---|
| Run and job names | Neutral and index-only: `run`, `run (2)`. Never a repository name or an issue title. |
| Matrix values | Indices only. The project assignment travels in the encrypted selection, not in matrix values, which can appear in job names. |
| Actions log | The agent's and the checks' output already goes to files, not the log. Every other step is audited, and a test fails if a log line contains project text. |
| Artifacts | Encrypted before upload (symmetric, integrity-protected), 3-day retention. |
| Issues, PRs, comments | Live in the private project repository, written by `publish`. The runner repository gets none. |
| Secrets | In the runner repository's secrets, masked in logs. The encryption key is exposed only to the encrypt and decrypt steps. |
| Who can trigger | Only the owner. Nothing runs from fork pull requests or from issues opened by anyone else. |

**Leak tests.** A blocklist (repository names, the organisation name, work email domains) is read from the private store at test time and matched against the public repositories' tracked files and against captured logs of a test run. The blocklist is never written into a public repository, since writing the names there would be the leak.

**Residual exposure** (accepted): that a run happened, when, and for how long; the encrypted artifact's size.

## 7. Changes to the harness

1. `select` across repositories, reading the project list from a private source.
2. The run job takes its home repository as an input instead of `github.repository`, with a token per owner. This generalises today's `target` clone step.
3. `publish` writes to a repository other than the one running the workflow.
4. Encrypt in `run`, decrypt in `publish`; retention input lowered.
5. Neutral run, job and concurrency names, with tests.
6. Close-merged and merged-PR detection moved into the runner, since the per-project `agent-close-merged` workflow runs in the private repository and uses its quota.
7. A per-owner token map and an owner-only gate that does not rely on `repository_owner` alone.
8. The leak check described above.

No project-specific names or conventions enter the harness. The harness stays stack-agnostic and generic.

## 8. Rollout

1. Build the runner and the harness changes behind the existing per-repository mode, which keeps working until cutover.
2. Prove it on one low-risk project: queue a task, watch it end to end, read the public run page as a stranger would.
3. Move the remaining personal projects.
4. Move the most sensitive project last, after the leak tests have passed on all the others. Its repository carries the strictest review of public output.
5. After each cutover, remove that project's `agent.yml` and `agent-close-merged` workflow, and re-pin nothing: the runner pins the harness tag.

## 9. Risks and things to verify before relying on them

- **Cron timing.** Scheduled workflows start late under load, and GitHub disables scheduled workflows in a public repository after 60 days without a commit (from memory; verify). The manual start is the fallback, and a keep-alive commit may be needed.
- **Matrix values and job names.** Confirm that nothing from a matrix reaches a public page except the index.
- **Token scopes.** Confirm the exact fine-grained token permissions for read, push, PR and issue writes, and whether an organisation requires approval for tokens that reach its repositories.
- **Encryption tool.** Symmetric `gpg` ships on hosted runners and is integrity-protected; confirm before choosing it over `age`.
- **Key compromise.** One key protects 3 days of ciphertext. Rotating it is a secret change, and takes effect for new runs only.
- **Public-repository abuse.** Anyone can open issues or pull requests in the runner repository. No workflow reacts to them, but this should be proven by test.
- **History.** Anything already published in a public repository stays in clones and forks. Fixing the past is separate from this design.
- **Harness private.** If the harness itself became private, public callers could not use its reusable workflows. This design assumes the harness stays public.

## 10. Out of scope, noted

- The learning system that reads the private store's run records.
- Moving a project's own PR CI off its repository quota.
