set -e
. "$(dirname "$0")/lib.sh"
git -C target checkout -q -b elsewhere
ready_report
