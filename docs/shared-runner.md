# Shared runner

One public repository runs the harness for any number of private projects. Public repositories get free hosted-runner minutes. Nothing about a project is readable in public except that a run happened, when it started and how long it took.

## What is public and what is not

| Public | Hidden |
|---|---|
| That a run happened, its time and duration | Repository names, task titles, plans, code, diffs, test output, agent output |
| Constant job names (`clone 0`, `run 1`) and artifact names that are an HMAC tag | Issues, PRs and comments (they live in the private project) |
| Encrypted artifacts: the selection (1 day), the handoffs (1 day), the sealed run output (3 days) | The project list, the run records, every key |

## How a run is isolated

The agent and the project's own install and check commands run code the harness does not control. Anything a job references is loaded into its runner process, and hosted runners give the job root, so a job that runs project code must not reference a repository token or a key that opens another project.

- **Trusted jobs** (`select`, `clone`, `publish`) run only harness code and hold the tokens.
- **The untrusted job** (`run`) holds the Claude token, its own slot key and the public half of the publish key. Nothing else.
- Each of the three slots has its own jobs and its own `SLOT_KEY_<n>`. A slot's `run` makes a key pair in its own VM and publishes the public half. `clone` seals the checkout to that key; `run` opens it, works, and seals its output to the publish key, which it can encrypt with but not decrypt.
- Artifact names are `pub-`, `bundle-` and `out-` plus an HMAC of the run id under the slot key, so a job of another slot cannot create them first.
- Every handoff carries a proof under the slot key (an HMAC over the run, attempt, slot and content) that is checked before use, so replacing an artifact after it appears does not work for a job of another slot. Everything is bound to the run attempt.
- `publish` never trusts the run's verdict where it reaches git: the issue, branch, base, task and title come from the trusted selection, and every target repository, branch, bundle and base SHA is checked against it.
- A project marked `"isolated": true` in the project list runs alone in its round, and only when nothing else is running. Use it for the most sensitive project.
- The project list is the only place that decides which repositories a run may clone. A project's own `agent.config.json` and `.gitmodules` can only choose from it.

## Setup

1. Create a public repository for the runner with a neutral name. It holds only `.github/workflows/runner.yml`, copied from `templates/runner.yml`.
2. Create a private repository for the store. Put the project list at `runner/projects.json`:

   ```json
   {
     "projects": [
       { "repo": "owner/project-a" },
       { "repo": "owner/project-b", "isolated": true, "target": { "repo": "org/code", "allow": ["org/sub-a"] } }
     ],
     "maxParallel": 3
   }
   ```

   `tokenOwner` (default: the repository's owner) picks which owner's tokens reach a project. `target` lists the one target repository the project may use, the token owner for it, the submodule repositories allowed (`allow`) and extra safe branch prefixes (`branchPrefixes`). `maxParallel` is 1 to 3.
3. Make the publish key pair and three slot keys:

   ```
   node harness/cli.mjs keygen --out publish-keys
   openssl rand -hex 32     # run three times, one per slot
   ```

   Keep `publish-keys/private.key` somewhere safe: it is the only thing that opens a sealed run output later.
4. Set these secrets on the runner repository:
   - `CLAUDE_CODE_OAUTH_TOKEN`, and optionally `CLAUDE_CODE_OAUTH_TOKEN_2`
   - `RUNNER_TOKENS`: `{"owner":["<fine-grained>","<classic>"],"org":["<token>"]}`
   - `RUN_KEY`: 16 or more random characters
   - `STORE_REPO`: `owner/store`; `STORE_TOKEN`: reads the project list and writes run records
   - `PUBLISH_PUBLIC_KEY` and `PUBLISH_PRIVATE_KEY`: the contents of the two key files
   - `SLOT_KEY_0`, `SLOT_KEY_1`, `SLOT_KEY_2`
5. In each project keep `agent.config.json` and the plans as today. When you cut a project over, remove its `.github/workflows/agent.yml` and `agent-close-merged.yml`. Label an issue `agent` as before.
6. Start a round by hand with `gh workflow run runner.yml --repo <owner>/<runner>`, or wait for the schedule.

## How a round works

`select` reads the project list, takes the next runnable task of up to `maxParallel` projects (one per project) and marks each `agent:running`. Each chosen project runs in its own slot: `clone`, then `run`, then `publish`. `continue` starts another round while work remains.

A project whose `agent:running` label is under 4 hours old is left alone. An older one is treated as a crashed run: it is released as blocked and its comment says so. A task paused by a usage limit (`agent:waiting`) keeps its place and is only resumed by the scheduled run.

## How tokens are chosen

Each owner has an ordered list, fine-grained first and classic last. For every project the runner tries them in order and uses the first that can read the repository and, for the steps that write, push to it. A project that no token can reach is skipped.

A classic token reaches every private repository its owner can reach. Use one token per owner, give each an expiry, and rotate them. They are referenced only by trusted jobs.

## Opening a sealed run output

Download the artifact `out-<tag>` from the run page. The output is sealed to the publish key and bound to its run and slot:

    OPEN_PRIVATE_KEY="$(cat publish-keys/private.key)" node harness/cli.mjs open --in run-output.sealed --dir out --aad "<run id>-<attempt>:<slot>"

## If something looks wrong

- A run of a project that might have run hostile code: rotate that slot's `SLOT_KEY_<n>` and the Claude token. The repository tokens were never in the run job.
- The repository's tokens or `RUN_KEY` leaked some other way: rotate them. They take effect for new runs.

## Verify these on the first dry run

Some of what this relies on is GitHub's behaviour and can only be checked there. Use a scratch public runner repository and scratch private projects first.

1. A job that does not reference a secret does not receive it. Put a canary secret in the workflow's declared secrets, reference it only in one job, and read the runner process memory of another job.
2. The public run page shows only constant job names and artifact names that are tags.
3. Which actor a round started by `gh workflow run` with the workflow's own token has (the template admits `github-actions[bot]`).
4. On a re-run, which artifacts are listed (the earlier attempt's too) and what `name=` returns, and that "Re-run failed jobs" stops at once with the re-run-all message.
5. What the repository API reports as `permissions.push` for a fine-grained token (it may describe the user, not the token).
6. That a label that does not exist is created by adding it to an issue.
7. That artifacts of a run can be deleted and re-uploaded by another job of the same run, and that the proofs make that useless.
8. That scheduled workflows in a public repository are disabled after 60 days without activity, and what re-enables them.

## Residual risks

- The run job holds the Claude token and its slot key. A compromised run can burn that usage or print the token. If it prints the slot key, the thief can forge that slot's handoffs in a later round it is also running in, and nothing detects the theft: rotate slot keys on a schedule, and mark the most sensitive project `isolated`.
- A compromised run can write a wrong but well-formed verdict for its own project. Its pull request is still reviewed by a person.
- Run existence, timing, duration and the size of the sealed artifacts are public.

## Checking for leaks

Keep a blocklist (one term per line) in the private store, never in a public repository, and run:

    node harness/cli.mjs leak-scan --blocklist blocklist.txt --root <public checkout> --file run.log

It prints `path:line` for each hit and never prints the term.
