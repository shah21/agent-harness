. "$(dirname "$0")/review-lib.sh"
review_json "{\"status\":\"CLEAN\",\"findings\":[$(finding R1 low greeting.txt style)]}"
