cat > "$REPORT_PATH" <<'REPORT'
STATUS: BLOCKED
TASK: plan=docs/plan.md task=1 issue=#7
BLOCKER:
Needs a secret that does not exist.
EVIDENCE:
$ echo $DEPLOY_KEY
(empty)
REQUIRED_HUMAN_ACTION:
Provide DEPLOY_KEY.
REPORT
