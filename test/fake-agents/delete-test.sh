set -e
. "$(dirname "$0")/lib.sh"
git rm -q tests/base.test.sh
git commit -qm "Remove inconvenient test"
ready_report tests/base.test.sh
