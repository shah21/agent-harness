You are executing one task from an implementation plan, unattended. No human will answer questions during this run.

- Task: Task {{TASK}} — {{TASK_TITLE}}
- Plan file: {{PLAN}} (relative to the repository root, which is your working directory)
- Issue: #{{ISSUE}}
- Branch: {{BRANCH}} (already checked out; stay on it)

## What to do

1. Read the plan file: its header sections (goal, architecture, global constraints) and Task {{TASK}} in full. Implement only Task {{TASK}}.
2. Follow the task's steps, including its tests and verification commands.
3. Run every project check before reporting:
{{CHECKS}}
4. Commit your work on this branch with clear messages. Do not push and do not open pull requests.
5. Write the report described below to {{REPORT_PATH}}.

## Rules

- Do only what Task {{TASK}} asks. No unrelated refactoring, renames, or formatting changes.
- Never delete, skip, or weaken existing tests or assertions to get a green result.
- Never modify these protected paths: {{PROTECTED}}.
- Wrap every test, build, or lint command in `timeout 600`, for example `timeout 600 pnpm test`.
- Never start dev servers, watchers, or any process that does not exit on its own.
- Earlier tasks of this plan may already be implemented in this branch's history; build on them.
- If the plan does not match the code, a dependency or secret is missing, or the task cannot be done safely, stop and report BLOCKED with evidence. Do not improvise around the plan.

## Report format

Write exactly these fields to {{REPORT_PATH}}, each field name at the start of a line:

STATUS: READY_FOR_QA or BLOCKED
TASK: plan={{PLAN}} task={{TASK}} issue=#{{ISSUE}}
SUMMARY:
<2-5 lines>
CHANGED_FILES:
- <one path per line: every file changed by your commits>
CHECKS:
- <check name>: PASS or FAIL or NOT_RUN   (one line per project check listed above)
SELF_REVIEW:
<scope respected? tests added? risks?>
KNOWN_ISSUES:
<text, or None>

When STATUS is BLOCKED, also include:

BLOCKER:
<what stopped you, one or two lines>
EVIDENCE:
<the command you ran and the relevant output>
REQUIRED_HUMAN_ACTION:
<what the human must do before this task can be retried>

The harness re-runs every check itself after you finish and compares the results with your report. A report that claims PASS for a failing check is rejected.
