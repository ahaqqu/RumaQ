#!/usr/bin/env bash
# One change-set verdict contract for the scope gates (audit M1).
#
# Every gate answers one question — should its suite run for this change set
# — with one protocol:
#
#   stdout:  "run <label>: <why>"    exit 0   the suite runs
#            "skip <label>: <why>"   exit 0   the suite skips
#   stderr:  the error, or skip diagnostics   exit != 0   the caller fails
#
# A gate that cannot decide — bad usage, no repository root, an unreadable
# table — exits non-zero and prints no verdict: the caller must fail the job,
# never read the error as a skip. Callers consume the VERDICT WORD (the first
# token of stdout), not the exit status.
#
# The per-target skippable table is skippable-paths.txt beside this lib
# (audit S5): first matching row wins; a path matching no row reaches the
# gate, so the suite runs unless every path matches a skip row.

SCOPE_TABLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../skippable-paths.txt"

# scope_gate_resolve <label> [--from-stdin] — prints the change set, one path
# per line. Only "" or --from-stdin is accepted: a typo'd flag must be a usage
# error (exit 2), not a silent fallback to the git resolution.
scope_gate_resolve() {
  local label=$1 flag=${2:-}
  case "$flag" in
    '') bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../changed-paths.sh" ;;
    --from-stdin) cat ;;
    *)
      printf '%s: unknown argument %s — usage: [--from-stdin]\n' "$label" "$flag" >&2
      exit 2
      ;;
  esac
}

# scope_gate_cannot_reach <target> <path> — 0 when a table row says the path
# cannot reach the gate, 1 when a run row matches or no row does (fail safe).
scope_gate_cannot_reach() {
  local target=$1 path=$2
  local row_target row_verdict pattern
  while read -r row_target row_verdict pattern; do
    case "$row_target" in '' | '#'*) continue ;; esac
    [ "$row_target" = "$target" ] || continue
    if printf '%s\n' "$path" | grep -qE -- "$pattern"; then
      [ "$row_verdict" = skip ]
      return
    fi
  done <"$SCOPE_TABLE"
  return 1
}

# scope_gate_main <target> <label> <skip-reason> <run-reason> [<args>...]
# Prints the verdict line on stdout and the skipped paths on stderr.
scope_gate_main() {
  local target=$1 label=$2 skip_reason=$3 run_reason=$4
  shift 4

  local changed
  changed=$(scope_gate_resolve "$label" "$@") || exit $?

  if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
    printf 'run %s: no change set available — running (fail safe)\n' "$label"
    return 0
  fi

  # The table decides from here on: a table the gate cannot read is a gate
  # that cannot decide — the machine table's error row, not a silent
  # fail-safe run (audit M1).
  if [ ! -r "$SCOPE_TABLE" ]; then
    printf '%s: skippable-path table is missing or unreadable: %s\n' "$label" "$SCOPE_TABLE" >&2
    exit 3
  fi

  if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
    printf 'run %s: no change set available — running (fail safe)\n' "$label"
    return 0
  fi

  local skipped=true
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if ! scope_gate_cannot_reach "$target" "$path"; then
      skipped=false
      break
    fi
  done <<EOF
$changed
EOF

  if [ "$skipped" = true ]; then
    printf 'skip %s: %s\n' "$label" "$skip_reason"
    printf '%s\n' "$changed" | grep -v '^[[:space:]]*$' | head -5 | sed 's/^/  /' >&2
  else
    printf 'run %s: %s\n' "$label" "$run_reason"
  fi
}
