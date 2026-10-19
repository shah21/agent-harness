#!/usr/bin/env bash
# Checks out each pull request's head (detached) in its repository and records the merge base with
# its base branch. Tokens authenticate these fetches only; nothing is written to disk.
set -euo pipefail
: "${PLAN:?}" "${PROJECT:?}" "${OUT:?}"

result='[]'
count=$(jq length "$PLAN")
for ((i = 0; i < count; i++)); do
  entry=$(jq -c ".[$i]" "$PLAN")
  dir="$PROJECT/$(jq -r .dir <<<"$entry")"
  head=$(jq -r .headSha <<<"$entry")
  base=$(jq -r .baseRef <<<"$entry")
  token=""
  case "$(jq -r .auth <<<"$entry")" in
    consumer) token="${CONSUMER_TOKEN:-}" ;;
    target) token="${TARGET_TOKEN:-}" ;;
  esac
  args=()
  if [ -n "$token" ]; then
    args=(-c "http.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')")
  fi
  git -C "$dir" ${args[@]+"${args[@]}"} fetch -q origin "$head" "+refs/heads/$base:refs/remotes/origin/$base"
  git -C "$dir" checkout -q --detach "$head"
  if [ -f "$dir/.gitmodules" ]; then
    git -C "$dir" ${args[@]+"${args[@]}"} submodule update -q --init --recursive
  fi
  merge_base=$(git -C "$dir" merge-base "$head" "origin/$base")
  result=$(jq -c --argjson e "$entry" --arg mb "$merge_base" '. + [$e + {baseSha: $mb}]' <<<"$result")
done
printf '%s\n' "$result" > "$OUT"
