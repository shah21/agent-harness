set -e
. "$(dirname "$0")/lib.sh"
cd target/packages/core
echo b > lib.txt
git add -A
git commit -qm "Change lib"
cd ../../..
ready_report target/packages/core/lib.txt
