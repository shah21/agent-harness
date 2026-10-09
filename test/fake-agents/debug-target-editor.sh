set -e
. "$(dirname "$0")/debug-lib.sh"
echo x >> target/app.txt
echo y >> target/packages/core/lib.txt
debug_report FINDINGS "value.txt holds a bad value" CONFIRMED
