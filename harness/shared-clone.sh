#!/usr/bin/env bash
# Clones the chosen project, and its target repository if it has one, with the token the
# selection resolved. This runs in a trusted job: it holds tokens and reads repository content it
# does not control, so it never lets that content decide what is fetched.
#   - The token is handed to git as a one-command header: never in a URL, never in git config on
#     disk, never echoed.
#   - git is limited to https and never prompts.
#   - git's stderr is silenced because its errors name the repository, and this runs where logs
#     are public.
#   - The project is cloned without submodules. The target's submodules are initialised one by
#     one, at every depth, and only if every submodule it lists is on the owner's allow-list.
set -Eeuo pipefail
entry="${1:?entry.json}"
dest="${2:?destination}"
: "${RUNNER_TOKENS:?}"
export GIT_ALLOW_PROTOCOL=https GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
CLI="$(cd "$(dirname "$0")" && pwd)/cli.mjs"

fail() { echo "clone failed" >&2; exit 1; }
token_for() { jq -r --arg o "$1" --argjson i "$2" '.[$o][$i] // empty' <<<"$RUNNER_TOKENS"; }

# Initialises the submodules of the checkout in $1, then theirs. $2 is the header, $3 the depth.
init_submodules() {
  local dir="$1" header="$2" depth="$3" paths path
  [ -f "$dir/.gitmodules" ] || return 0
  [ "$depth" -le 4 ] || fail
  paths="$(node "$CLI" submodule-plan --entry "$entry" --gitmodules "$dir/.gitmodules" 2>/dev/null)" || fail
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    git -c "http.https://github.com/.extraheader=$header" -C "$dir" submodule update -q --init -- "$path" 2>/dev/null || fail
    init_submodules "$dir/$path" "$header" $((depth + 1))
  done <<<"$paths"
}

clone() { # repo token ref path withSubmodules
  local repo="$1" token="$2" ref="$3" path="$4" subs="$5"
  [ -n "$token" ] || fail
  echo "::add-mask::$token"
  local b64 header
  b64="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  echo "::add-mask::$b64"
  header="AUTHORIZATION: basic $b64"
  git -c "http.https://github.com/.extraheader=$header" clone -q --no-checkout "https://github.com/${repo}.git" "$path" 2>/dev/null || fail
  if [ -n "$ref" ]; then
    git -c "http.https://github.com/.extraheader=$header" -C "$path" checkout -q "$ref" 2>/dev/null || fail
  else
    git -c "http.https://github.com/.extraheader=$header" -C "$path" checkout -q 2>/dev/null || fail
  fi
  if [ "$subs" = "yes" ]; then init_submodules "$path" "$header" 0; fi
}

repo=$(jq -r .repo "$entry")
base=$(jq -r .selection.base "$entry")
clone "$repo" "$(token_for "$(jq -r .tokenOwner "$entry")" "$(jq -r .tokenIndex "$entry")")" "$base" "$dest" no

t_repo=$(jq -r '.target.repo // empty' "$entry")
if [ -n "$t_repo" ] && [ -z "$(jq -r '.target.error // empty' "$entry")" ]; then
  t_dest="$dest/$(jq -r .target.path "$entry")"
  # The run reports a missing target itself, as it always has: this is not fatal. A partly
  # cloned target is removed so the run never sees half of it.
  if ! (clone "$t_repo" \
    "$(token_for "$(jq -r .target.tokenOwner "$entry")" "$(jq -r .target.tokenIndex "$entry")")" \
    "$(jq -r '.target.ref // empty' "$entry")" \
    "$t_dest" yes); then
    rm -rf "$t_dest"
    echo "target checkout failed" > "$(dirname "$entry")/target-checkout.txt"
  fi
fi
