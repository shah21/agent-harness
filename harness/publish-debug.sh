#!/usr/bin/env bash
# Publishes a debug verdict: an issue comment and label changes. Never touches branches or PRs.
set -Eeuo pipefail
: "${VERDICT:?}" "${REPO:?}" "${GH_TOKEN:?}" "${RUN_URL:?}"

CLI="$(cd "$(dirname "$0")" && pwd)/cli.mjs"
TMP=$(mktemp -d)
issue=$(jq -r .issue "$VERDICT")
outcome=$(jq -r .outcome "$VERDICT")
stage="start"

# Whatever fails below, the issue must end labelled and commented.
on_error() {
  local code=$?
  trap - ERR
  printf '%s\n' "⛔ **BLOCKED** (harness)" "" "- publishing failed at step: ${stage}" "" \
    "[Run log and artifacts](${RUN_URL})" "" 'To retry: remove `agent:blocked` and add `debug`.' > "$TMP/fail.md"
  gh issue edit "$issue" --repo "$REPO" --remove-label agent:running --remove-label debug --add-label agent:blocked >/dev/null 2>&1 || true
  gh issue comment "$issue" --repo "$REPO" --body-file "$TMP/fail.md" >/dev/null 2>&1 || true
  exit "$code"
}
trap on_error ERR

stage="labels"
gh issue edit "$issue" --repo "$REPO" --remove-label agent:running --remove-label agent:blocked --remove-label agent:debug-done >/dev/null || true
case "$outcome" in
  FINDINGS|INCONCLUSIVE) gh issue edit "$issue" --repo "$REPO" --remove-label debug --add-label agent:debug-done >/dev/null ;;
  WAITING) ;;
  *) gh issue edit "$issue" --repo "$REPO" --remove-label debug --add-label agent:blocked >/dev/null ;;
esac

stage="comment"
node "$CLI" render-debug-comment --verdict "$VERDICT" --run-url "$RUN_URL" > "$TMP/comment.md"
gh issue comment "$issue" --repo "$REPO" --body-file "$TMP/comment.md" >/dev/null
echo "published ${outcome} for #${issue}"
