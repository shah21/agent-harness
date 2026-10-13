. "$(dirname "$0")/review-lib.sh"
review_json "{\"status\":\"FINDINGS\",\"findings\":[$(finding R1 high greeting.txt "rule-$AGENT_REVIEW_ROUND")]}"
