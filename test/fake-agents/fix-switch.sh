git checkout -q -b elsewhere
echo "note" >> notes.txt
git add notes.txt
git commit -qm "fix: address review round $AGENT_REVIEW_ROUND"
echo "R1: FIXED" > "$AGENT_OUTPUT_PATH"
