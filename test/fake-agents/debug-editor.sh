set -e
. "$(dirname "$0")/debug-lib.sh"
echo changed > value.txt
echo junk > junk.txt
git add -A
git -c user.name=t -c user.email=t@example.com commit -qm sneaky
echo more > value.txt
debug_report FINDINGS "value.txt holds a bad value" CONFIRMED
