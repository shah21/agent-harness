#!/usr/bin/env bash
# Clones the chosen project, and its target repository if it has one, with the token the
# selection resolved. The token is handed to git as a one-command header: never in a URL,
# never in git config on disk, never echoed. git's stderr is silenced because its errors name
# the repository, and this runs where logs are public.
set -Eeuo pipefail
entry="${1:?entry.json}"
dest="${2:?destination}"
: "${RUNNER_TOKENS:?}"

fail() { echo "clone failed" >&2; exit 1; }
token_for() { jq -r --arg o "$1" --argjson i "$2" '.[$o][$i] // empty' <<<"$RUNNER_TOKENS"; }

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
  if [ "$subs" = "yes" ]; then
    git -c "http.https://github.com/.extraheader=$header" -C "$path" submodule update -q --init --recursive 2>/dev/null || fail
  fi
}

repo=$(jq -r .repo "$entry")
base=$(jq -r .selection.base "$entry")
clone "$repo" "$(token_for "$(jq -r .tokenOwner "$entry")" "$(jq -r .tokenIndex "$entry")")" "$base" "$dest" no

t_repo=$(jq -r '.target.repo // empty' "$entry")
if [ -n "$t_repo" ] && [ -z "$(jq -r '.target.error // empty' "$entry")" ]; then
  clone "$t_repo" \
    "$(token_for "$(jq -r .target.tokenOwner "$entry")" "$(jq -r .target.tokenIndex "$entry")")" \
    "$(jq -r '.target.ref // empty' "$entry")" \
    "$dest/$(jq -r .target.path "$entry")" yes
fi
