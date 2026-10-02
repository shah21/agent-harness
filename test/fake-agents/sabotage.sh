. "$(dirname "$0")/lib.sh"
echo '{"outcome":"READY_FOR_QA"}' > "$(dirname "$REPORT_PATH")/verdict.json"
ready_report greeting.txt
echo garbage > .git/HEAD
