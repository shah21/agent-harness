#!/usr/bin/env bash
# Publishes a verdict: PR for READY_FOR_QA, issue comment for BLOCKED.
# Runs after the agent has exited; this is the only step holding a push-capable token.
set -euo pipefail
: "${VERDICT:?}" "${REPO:?}" "${GH_TOKEN:?}" "${RUN_URL:?}" "${PROJECT_DIR:?}"

CLI="$(cd "$(dirname "$0")" && pwd)/cli.mjs"
field() { jq -r "$1" "$VERDICT"; }

issue=$(field .issue)
outcome=$(field .outcome)
branch=$(field .branch)
base=$(field .baseBranch)
commits=$(field '.commits // 0')
task=$(field .task)
title=$(field .taskTitle)

gh issue edit "$issue" --repo "$REPO" \
  --remove-label agent:running --remove-label agent:ready --remove-label agent:blocked >/dev/null || true

push_branch() {
  git -C "$PROJECT_DIR" push --force --quiet \
    "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "HEAD:refs/heads/${branch}"
}

pr=""
if [ "$outcome" = "READY_FOR_QA" ]; then
  push_branch
  body=$(mktemp)
  node "$CLI" render-pr --verdict "$VERDICT" > "$body"
  pr=$(gh pr list --repo "$REPO" --head "$branch" --state open --json url -q '.[0].url // empty')
  if [ -n "$pr" ]; then
    gh pr edit "$pr" --repo "$REPO" --base "$base" --body-file "$body" >/dev/null
  else
    pr=$(gh pr create --repo "$REPO" --base "$base" --head "$branch" --title "Task ${task}: ${title}" --body-file "$body")
  fi
  gh issue edit "$issue" --repo "$REPO" --add-label agent:ready >/dev/null
else
  if [ "$commits" -gt 0 ] && [ -d "$PROJECT_DIR/.git" ]; then
    push_branch
  fi
  gh issue edit "$issue" --repo "$REPO" --add-label agent:blocked >/dev/null
fi

comment=$(mktemp)
if [ -n "$pr" ]; then
  node "$CLI" render-comment --verdict "$VERDICT" --run-url "$RUN_URL" --pr-url "$pr" > "$comment"
else
  node "$CLI" render-comment --verdict "$VERDICT" --run-url "$RUN_URL" > "$comment"
fi
gh issue comment "$issue" --repo "$REPO" --body-file "$comment" >/dev/null
echo "published ${outcome} for #${issue} ${pr}"
