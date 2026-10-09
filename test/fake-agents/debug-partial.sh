set -e
. "$(dirname "$0")/debug-lib.sh"
debug_report FINDINGS "value.txt holds a bad value" CONFIRMED
sleep 30
