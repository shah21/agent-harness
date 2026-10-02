# Shared helper for fake agents: write a READY_FOR_QA report listing the given files.
ready_report() {
  {
    echo "STATUS: READY_FOR_QA"
    echo "TASK: plan=docs/plan.md task=1 issue=#7"
    echo "SUMMARY:"
    echo "Did the task."
    echo "CHANGED_FILES:"
    for f in "$@"; do echo "- $f"; done
    echo "CHECKS:"
    echo "- test: PASS"
    echo "- lint: PASS"
    echo "SELF_REVIEW:"
    echo "Looks fine."
    echo "KNOWN_ISSUES:"
    echo "None"
  } > "$REPORT_PATH"
}
