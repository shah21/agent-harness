#!/usr/bin/env bash
# Waits for an artifact that only this slot's jobs can name, then saves its single file.
#   usage: wait-artifact.sh <label> <outfile> [timeout-seconds]
#   env:   SLOT_KEY GH_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID [WAIT_INTERVAL]
# The name is label-<hmac of the run id under the slot key>, so a job of another slot cannot
# create it first. Only this run's artifacts are listed. Messages are fixed: this runs where
# logs are public.
set -Eeuo pipefail
label="${1:?label}"
out="${2:?outfile}"
timeout="${3:-1800}"
: "${SLOT_KEY:?}" "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}"
CLI="$(cd "$(dirname "$0")" && pwd)/cli.mjs"

tag="$(node "$CLI" tag --run-id "$GITHUB_RUN_ID" --label "$label" 2>/dev/null)" || { echo "handoff failed" >&2; exit 1; }
name="${label}-${tag}"
interval="${WAIT_INTERVAL:-5}"
deadline=$(( $(date +%s) + timeout ))
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

id=""
while :; do
  id="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/artifacts?name=${name}&per_page=1" --jq '.artifacts[0].id // empty' 2>/dev/null || true)"
  [ -z "$id" ] || break
  [ "$(date +%s)" -lt "$deadline" ] || { echo "handoff timed out" >&2; exit 1; }
  sleep "$interval"
done

gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${id}/zip" > "$work/a.zip" 2>/dev/null || { echo "handoff failed" >&2; exit 1; }
[ "$(unzip -Z1 "$work/a.zip" 2>/dev/null | wc -l | tr -d ' ')" = "1" ] || { echo "handoff was not a single file" >&2; exit 1; }
unzip -p "$work/a.zip" > "$out" 2>/dev/null || { echo "handoff failed" >&2; exit 1; }
