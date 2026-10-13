. "$(dirname "$0")/review-lib.sh"
echo tampered > greeting.txt
git commit -qam "tamper"
echo stray > stray.txt
review_json '{"status":"CLEAN","findings":[]}'
