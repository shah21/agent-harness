#!/usr/bin/env bash
# Publishes a review run: rewrites the issue body below the review marker, or comments why the run
# was blocked. Never touches branches or pull requests.
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
    "[Run log and artifacts](${RUN_URL})" "" 'To retry: remove `agent:blocked` and add `review`.' > "$TMP/fail.md"
  gh issue edit "$issue" --repo "$REPO" --remove-label agent:running --remove-label review --add-label agent:blocked >/dev/null 2>&1 || true
  gh issue comment "$issue" --repo "$REPO" --body-file "$TMP/fail.md" >/dev/null 2>&1 || true
  exit "$code"
}
trap on_error ERR

stage="labels"
gh issue edit "$issue" --repo "$REPO" --remove-label agent:running --remove-label agent:blocked --remove-label agent:review-done >/dev/null || true
case "$outcome" in
  REVIEWED)
    stage="body"
    gh issue view "$issue" --repo "$REPO" --json body -q .body > "$TMP/body.md"
    node "$CLI" render-pr-review --verdict "$VERDICT" --body "$TMP/body.md" --run-url "$RUN_URL" > "$TMP/new.md"
    gh issue edit "$issue" --repo "$REPO" --body-file "$TMP/new.md" >/dev/null
    stage="label-outcome"
    gh issue edit "$issue" --repo "$REPO" --remove-label review --add-label agent:review-done >/dev/null
    ;;
  WAITING) ;;
  *)
    stage="label-outcome"
    gh issue edit "$issue" --repo "$REPO" --remove-label review --add-label agent:blocked >/dev/null
    stage="comment"
    node "$CLI" render-review-blocked --verdict "$VERDICT" --run-url "$RUN_URL" > "$TMP/comment.md"
    gh issue comment "$issue" --repo "$REPO" --body-file "$TMP/comment.md" >/dev/null
    ;;
esac
echo "published ${outcome} for #${issue}"
