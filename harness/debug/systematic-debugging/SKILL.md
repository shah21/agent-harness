---
name: systematic-debugging
description: Read-only root-cause investigation of a bug, failure or unexpected behavior. Produces findings, never a fix.
---

# Systematic Debugging (read-only)

Adapted from the superpowers `systematic-debugging` skill (MIT, see `../LICENSE-superpowers`).

## Iron law

```
NO CONCLUSION WITHOUT EVIDENCE
```

You investigate; you never change the project. Do not edit, create or delete project files, do not commit, do not apply or test a fix. The only file you write is the report. A claim is `CONFIRMED` only when you saw it in code you read or output you produced.

Nobody can answer questions during this run. When you need information you do not have, say so under `UNKNOWNS` and `HUMAN_INPUT_NEEDED` and carry on with what you can establish.

## Phase 1: root cause investigation

1. **Read the symptom carefully.** Error messages, stack traces, line numbers, status codes: note them exactly.
2. **Reproduce when you safely can.** Run the failing test, script or query read-only. Record the exact command and output. If you cannot or should not, say `NOT_ATTEMPTED` or `NOT_REPRODUCED` and why.
3. **Check what changed.** `git log`, `git blame`, `git diff <a>..<b>` between versions, changed dependencies, config differences.
4. **Trace the data flow backward.** Start where the bad value or error appears. Ask what called this, with what value, and keep going up until you find where it originates. Fix-location is irrelevant here: find the origin, not the symptom.
5. **Multi-component systems.** At each boundary (UI, API, service, database, queue) note what enters and what leaves, and find the first boundary where the data is already wrong. Use read-only observation only.

## Phase 2: pattern analysis

1. Find similar code that works, in the same codebase.
2. Read the working and the broken version completely and list every difference, however small.
3. Note the dependencies, settings and assumptions each relies on.

## Phase 3: hypotheses

1. State one hypothesis at a time: "I think X is the root cause because Y". Be specific.
2. Try to **falsify** it with the smallest read-only check: read the code path, run a read-only command, compare versions.
3. Record the outcome. Confirmed → `CONFIRMED`. Contradicted → drop it and say why. Plausible but unchecked → `INFERENCE`. Cannot be checked from here → `UNKNOWN`.
4. Rank the hypotheses that remain, most likely first. Keep competing ones in the report; do not discard them silently.

## Phase 4: conclusion

State the verified root cause, or `None` if you could not establish one. Name the owning module (the directory or file that should change). In `NEXT_ACTION` describe the smallest change that would address the cause, as text, and how someone could verify it. Do not make the change.

## Rules of thumb

- Simple bugs have root causes too; do not stop at the first plausible explanation.
- If you have been through several hypotheses without one surviving, say the cause is not established and list what is missing. That is a valid result.
- Never report a guess as a finding. `INCONCLUSIVE` with honest unknowns beats a confident wrong answer.
- Stop and write the report when you have enough evidence or when you run out of read-only ways to get more.
