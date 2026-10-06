#!/usr/bin/env bash
# Publishes a verdict: PR for READY_FOR_QA, issue comment for BLOCKED.
# Runs in its own job, on a VM the agent never touched. The agent's branch
# arrives only as a git bundle and is pushed from a fresh repository, so no
# hook or config the agent wrote can run while the write token is present.
set -Eeuo pipefail
: "${VERDICT:?}" "${REPO:?}" "${GH_TOKEN:?}" "${RUN_URL:?}"
BUNDLE="${BUNDLE:-}"
REMOTE="${PUSH_REMOTE:-https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git}"

CLI="$(cd "$(dirname "$0")" && pwd)/cli.mjs"
PUBLISH_TARGETS="$(cd "$(dirname "$0")" && pwd)/publish-targets.mjs"
BUNDLE_DIR="${BUNDLE_DIR:-}"
TMP=$(mktemp -d)
field() { jq -r "$1" "$VERDICT"; }

issue=$(field .issue)
outcome=$(field .outcome)
branch=$(field .branch)
base=$(field .baseBranch)
task=$(field .task)
title=$(field .taskTitle)
stage="start"

# Whatever fails below, the issue must end labelled and commented.
on_error() {
  local code=$?
  trap - ERR
  printf '%s\n' "⛔ **BLOCKED** (harness)" "" "- publishing failed at step: ${stage}" "" \
    "[Run log and artifacts](${RUN_URL})" "" 'To retry: remove `agent:blocked` and add `agent`.' > "$TMP/fail.md"
  if [ -s "$TMP/target-prs.json" ]; then
    { echo; echo "Opened before the failure:"; jq -r '.[] | "- `\(.repo)` #\(.number): \(.url)"' "$TMP/target-prs.json"; } >> "$TMP/fail.md"
  fi
  gh issue edit "$issue" --repo "$REPO" --remove-label agent:running --remove-label agent:ready --add-label agent:blocked >/dev/null 2>&1 || true
  gh issue comment "$issue" --repo "$REPO" --body-file "$TMP/fail.md" >/dev/null 2>&1 || true
  exit "$code"
}
trap on_error ERR

has_bundle() { [ -n "$BUNDLE" ] && [ -f "$BUNDLE" ]; }
has_targets() { [ "$(jq -r '(.targets // []) | map(select(.commits > 0)) | length' "$VERDICT")" -gt 0 ]; }

push_branch() {
  stage="push"
  local work="$TMP/repo"
  git init -q "$work"
  git -C "$work" fetch -q "$BUNDLE" "refs/heads/${branch}:refs/heads/${branch}"
  git -C "$work" -c core.hooksPath=/dev/null push --force -q "$REMOTE" "refs/heads/${branch}:refs/heads/${branch}"
}

# Removing `agent` too: an issue must never stay queued after a run, or the
# queue would re-dispatch it forever.
stage="labels"
gh issue edit "$issue" --repo "$REPO" --remove-label agent --remove-label agent:running \
  --remove-label agent:ready --remove-label agent:blocked --remove-label agent:waiting >/dev/null || true

pr=""
if [ "$outcome" = "READY_FOR_QA" ]; then
  if has_targets; then
    stage="targets"
    node "$PUBLISH_TARGETS" --verdict "$VERDICT" --bundle-dir "$BUNDLE_DIR" --out "$TMP/target-prs.json"
  fi
  if has_bundle || ! has_targets; then
    stage="bundle"
    has_bundle
    push_branch
    stage="pr"
    node "$CLI" render-pr --verdict "$VERDICT" > "$TMP/body.md"
    pr=$(gh pr list --repo "$REPO" --head "$branch" --state open --json url -q '.[0].url // empty')
    if [ -n "$pr" ]; then
      gh pr edit "$pr" --repo "$REPO" --base "$base" --title "Task ${task}: ${title}" --body-file "$TMP/body.md" >/dev/null
    else
      pr=$(gh pr create --repo "$REPO" --base "$base" --head "$branch" --title "Task ${task}: ${title}" --body-file "$TMP/body.md")
    fi
  fi
  stage="label-outcome"
  gh issue edit "$issue" --repo "$REPO" --add-label agent:ready >/dev/null
elif [ "$outcome" = "WAITING" ]; then
  # Out of usage on every account: nothing to push; a scheduled run resumes it.
  stage="label-outcome"
  gh issue edit "$issue" --repo "$REPO" --add-label agent:waiting >/dev/null
else
  if has_bundle; then
    push_branch
  fi
  stage="label-outcome"
  gh issue edit "$issue" --repo "$REPO" --add-label agent:blocked >/dev/null
fi

stage="comment"
args=(--verdict "$VERDICT" --run-url "$RUN_URL")
[ -n "$pr" ] && args+=(--pr-url "$pr")
[ -s "$TMP/target-prs.json" ] && args+=(--target-prs "$TMP/target-prs.json")
node "$CLI" render-comment "${args[@]}" > "$TMP/comment.md"
gh issue comment "$issue" --repo "$REPO" --body-file "$TMP/comment.md" >/dev/null
echo "published ${outcome} for #${issue} ${pr}"
