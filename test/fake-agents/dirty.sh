set -e
. "$(dirname "$0")/lib.sh"
echo 'test "$(cat greeting.txt)" = "hello"' > tests/greeting.test.sh
git add tests/greeting.test.sh
git commit -qm "Add greeting test"
echo hello > greeting.txt
ready_report greeting.txt tests/greeting.test.sh
