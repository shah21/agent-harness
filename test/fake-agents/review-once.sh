. "$(dirname "$0")/review-lib.sh"
if [ "$AGENT_REVIEW_ROUND" = "1" ]; then
  review_json "{\"status\":\"FINDINGS\",\"findings\":[$(finding R1 high greeting.txt plan-mismatch),$(finding R2 low greeting.txt style)]}"
else
  review_json '{"status":"CLEAN","findings":[]}'
fi
