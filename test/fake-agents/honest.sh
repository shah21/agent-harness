set -e
. "$(dirname "$0")/lib.sh"
echo hello > greeting.txt
echo 'test "$(cat greeting.txt)" = "hello"' > tests/greeting.test.sh
git add -A
git commit -qm "Add greeting"
ready_report greeting.txt tests/greeting.test.sh
