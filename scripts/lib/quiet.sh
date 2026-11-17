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
  # The lines that name the problem. The pattern list is a best effort —
  # output that matches none of it must still say why: fall back to the
  # log's tail instead of leaving only the FAIL line (audit S9).
  summary=$(grep -aE 'FAIL |✗|×|AssertionError|Error:|^diff --git|not ok' "$log" 2>/dev/null | head -40 || true)
  if [ -n "$summary" ]; then
    printf '%s\n' "$summary" | sed 's/^/        /' || true
  else
    tail -20 "$log" 2>/dev/null | sed 's/^/        /' || true
  fi
  return "$code"
}
