set -e
. "$(dirname "$0")/lib.sh"
cd target
mkdir -p .github/workflows
echo "on: push" > .github/workflows/x.yml
git add -A
git commit -qm "CI"
cd ..
ready_report target/.github/workflows/x.yml
