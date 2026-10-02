set -e
. "$(dirname "$0")/lib.sh"
mkdir -p build
echo ok > build/flag
echo 'test -f build/flag' > tests/build.test.sh
git add tests/build.test.sh
git commit -qm "Test depends on build output"
ready_report tests/build.test.sh
