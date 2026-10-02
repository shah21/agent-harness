set -e
. "$(dirname "$0")/lib.sh"
echo 2 > value.txt
git commit -qam "Change value"
ready_report value.txt
