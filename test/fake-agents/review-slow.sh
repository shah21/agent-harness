sleep 5
. "$(dirname "$0")/review-lib.sh"
review_json '{"status":"CLEAN","findings":[]}'
