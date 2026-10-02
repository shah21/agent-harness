# Account "tok-a" runs out mid-task after committing partial work; any other account works honestly.
if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-a" ]; then
  echo partial > partial.txt
  git add -A
  git commit -qm "partial work"
  echo '{"type":"result","is_error":true,"api_error_status":429,"result":"Claude AI usage limit reached"}'
  exit 1
fi
exec sh "$(dirname "$0")/honest.sh"
