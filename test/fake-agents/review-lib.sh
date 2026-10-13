# Shared helpers for fake reviewers and fixers.
review_json() { printf '```json\n%s\n```\n' "$1" > "$AGENT_OUTPUT_PATH"; }
# finding <id> <severity> <file> <rule>
finding() { printf '{"id":"%s","severity":"%s","file":"%s","line":1,"rule":"%s","problem":"Problem %s.","fix":"Fix %s."}' "$1" "$2" "$3" "$4" "$1" "$1"; }
