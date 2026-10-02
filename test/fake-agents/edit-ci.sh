set -e
. "$(dirname "$0")/lib.sh"
mkdir -p .github/workflows
echo "name: x" > .github/workflows/x.yml
git add -A
git commit -qm "Touch CI"
ready_report .github/workflows/x.yml
