set -e
. "$(dirname "$0")/lib.sh"
env > "$(dirname "$REPORT_PATH")/agent-env.txt"
ready_report
