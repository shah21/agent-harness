. "$(dirname "$0")/review-lib.sh"
review_json '{"status":"FINDINGS","findings":[{"id":"R1","severity":"high","file":"greeting.txt","line":5,"rule":"plan-mismatch","problem":"Wrong.","fix":"Fix."}]}'
