for t in tests/*.test.sh; do
  sh "$t" || { echo "FAIL $t"; exit 1; }
done
