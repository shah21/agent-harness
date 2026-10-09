# Writes a debug report. Usage: debug_report STATUS ROOT_CAUSE TAG
debug_report() {
  {
    echo "STATUS: $1"
    echo "PROBLEM:"
    echo "The query fails with a 500."
    echo "REPRODUCTION:"
    echo "NOT_ATTEMPTED - stub agent"
    echo "EVIDENCE:"
    echo "value.txt:1 holds the bad value"
    echo "HYPOTHESES:"
    echo "1. value.txt holds a bad value - $3 - read the file"
    echo "ROOT_CAUSE:"
    echo "$2"
    echo "OWNING_MODULE:"
    echo "value.txt"
    echo "NEXT_ACTION:"
    echo "Correct the value."
    echo "UNKNOWNS:"
    echo "None"
    echo "HUMAN_INPUT_NEEDED:"
    echo "None"
  } > "$REPORT_PATH"
}
