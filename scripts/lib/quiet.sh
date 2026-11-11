#!/usr/bin/env bash
# Quiet runner for scripts an agent calls.
#
# The console shows a pass or fail line and, on failure, the lines that name
# the problem. The full output stays in a log file the caller points at, so an
# agent reads the summary instead of streaming a build or a test run.
#
#   . "$ROOT_DIR/scripts/lib/quiet.sh"
#   q_run "unit backend" "test-results/unit-backend.log" bunx vp test --project backend
#
# Returns the command's exit status; the caller decides whether to abort.
q_run() {
  local label=$1 log=$2 code=0
  shift 2
  mkdir -p "$(dirname "$log")"
  "$@" >"$log" 2>&1 || code=$?
  if [ "$code" -eq 0 ]; then
    printf '  pass  %s  (%s)\n' "$label" "$log"
    return 0
  fi
  printf '  FAIL  %s  (%s)\n' "$label" "$log"
  grep -aE 'FAIL |✗|×|AssertionError|Error:|^diff --git|not ok' "$log" 2>/dev/null \
    | head -40 | sed 's/^/        /'
  return "$code"
}
