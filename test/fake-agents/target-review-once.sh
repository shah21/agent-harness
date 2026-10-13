. "$(dirname "$0")/review-lib.sh"
if [ "$AGENT_REVIEW_ROUND" = "1" ]; then
  review_json "{\"status\":\"FINDINGS\",\"findings\":[$(finding R1 high target/packages/core/lib.txt plan-mismatch)]}"
else
  review_json '{"status":"CLEAN","findings":[]}'
fi
