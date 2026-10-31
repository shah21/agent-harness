# Shared runner

One public repository runs the harness for any number of private projects. Public repositories get free hosted-runner minutes. Nothing about a project is readable in public except that a run happened, when it started and how long it took.

## What is public and what is not

| Public | Hidden |
|---|---|
| That a run happened, its time and duration | Repository names, task titles, plans, code, diffs, test output, agent output |
| Neutral names: `run (0)`, `publish (1)` | Issues, PRs and comments (they live in the private project) |
| Encrypted run output, kept 3 days | The project list, the run records, the key |

## Setup

1. Create a public repository for the runner with a neutral name. It holds only `.github/workflows/runner.yml`, copied from `templates/runner.yml`.
2. Create a private repository for the store. Put the project list at `runner/projects.json`:

   ```json
   { "projects": [ { "repo": "owner/project-a" }, { "repo": "org/project-b", "tokenOwner": "owner", "targetTokenOwner": "org" } ], "maxParallel": 3 }
   ```

   `tokenOwner` picks which owner's tokens reach the project (default: the repository's owner). `targetTokenOwner` does the same for the project's `target` repository, if its `agent.config.json` has one.
3. Set these secrets on the runner repository:
   - `CLAUDE_CODE_OAUTH_TOKEN`, and optionally `CLAUDE_CODE_OAUTH_TOKEN_2`
   - `RUNNER_TOKENS`: `{"owner":["<fine-grained>","<classic>"],"org":["<token>"]}`
   - `RUN_KEY`: 16 or more random characters
   - `STORE_REPO`: `owner/store`
   - `STORE_TOKEN`: reads the project list and writes run records
4. In each project keep `agent.config.json` and the plans as today. When you cut a project over, remove its `.github/workflows/agent.yml` and `agent-close-merged.yml`. Label an issue `agent` as before.
5. Start a round by hand with `gh workflow run runner.yml --repo <owner>/<runner>`, or wait for the schedule.

## How a round works

`select` reads the project list, takes the next runnable task of up to `maxParallel` projects (one per project) and marks each `agent:running`. `run` does one job per chosen project. `publish` writes the result into the private project with that project's own token. `continue` starts another round while work remains.

A project whose `agent:running` label is under 3 hours old is left alone. An older one is treated as a crashed run: it is released as blocked and its comment says so. Tasks paused by a usage limit (`agent:waiting`) are only resumed by the scheduled run.

## How tokens are chosen

Each owner has an ordered list, fine-grained first and classic last. For every project the runner tries them in order and uses the first that can read the repository and, for the steps that write, push to it. A project that no token can reach is skipped.

A classic token reaches every private repository its owner can reach. Use one token per owner, give each an expiry, and rotate them.

## Opening an encrypted run output

Download the artifact `output-<n>` from the run page, then:

    RUN_KEY=<key> node harness/cli.mjs decrypt --in run-output.enc --dir out

## Checking for leaks

Keep a blocklist (one term per line) in the private store, never in a public repository, and run:

    node harness/cli.mjs leak-scan --blocklist blocklist.txt --root <public checkout> --file run.log

It prints `path:line` for each hit and never prints the term.
