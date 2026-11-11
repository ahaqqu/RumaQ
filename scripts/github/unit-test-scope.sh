#!/usr/bin/env bash
# Decides whether a unit-test suite is worth running.
#
# Usage: unit-test-scope.sh <frontend|backend> [--from-stdin]
#
# The frontend suite (the `frontend` and `frontend-dom` vitest projects) tests
# frontend/src; the backend suite tests backend/src with contract/. Skip only
# when every changed path provably cannot reach the suite under test, and run
# on anything unknown: the failure mode is a wasted minute, never a regression
# that merges green.
#
# Cross-workspace edges the rules must honor:
#   - frontend/src/plugins/registry.test.js imports backend's
#     plugins/manifests.js directly (plugin parity, plan §4.3), so
#     backend/src/plugins/ runs the frontend suite even though the rest of
#     backend/ skips it.
#   - Backend tests import contract/, so contract/ runs the backend suite.
#     The frontend app and tests import neither backend (outside the parity
#     test) nor contract.
#   - scripts/ runs both suites: the test plumbing (scripts/test.sh,
#     scripts/test/) lives there.
#
# --from-stdin takes the path list from stdin, which the offline guard test
# uses and a shell can use to check a hypothetical change set. Without it the
# list comes from changed-paths.sh, which carries the change-set resolution.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

suite=${1:-}
if [ "$suite" != frontend ] && [ "$suite" != backend ]; then
  echo "unit-test-scope: suite must be 'frontend' or 'backend'" >&2
  exit 2
fi

# True when the path cannot reach the suite's tests.
cannot_reach() {
  case "$1" in
    docs/* | .agents/* | automation/* | *.md) return 0 ;;
    frontend/*)
      # No backend test reads frontend files.
      [ "$suite" = backend ] && return 0
      return 1
      ;;
    backend/*)
      # The frontend parity test imports backend/src/plugins/manifests.js.
      case "$1" in backend/src/plugins/*) return 1 ;; esac
      [ "$suite" = frontend ] && return 0
      return 1
      ;;
    contract/*)
      # Backend tests import contract/; the frontend suite does not.
      [ "$suite" = frontend ] && return 0
      return 1
      ;;
    tools/*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "${2:-}" = "--from-stdin" ]; then
  changed=$(cat)
else
  changed=$(bash "$root/scripts/github/changed-paths.sh")
fi

if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
  echo "unit-test-scope($suite): no change set available — running (fail safe)"
  exit 0
fi

skipped=true
while IFS= read -r path; do
  [ -z "$path" ] && continue
  if ! cannot_reach "$path"; then
    skipped=false
    break
  fi
done <<EOF
$changed
EOF

if [ "$skipped" = true ]; then
  echo "unit-test-scope($suite): change set cannot reach the $suite suite — skipped"
  printf '%s\n' "$changed" | grep -v '^[[:space:]]*$' | head -5 | sed 's/^/  /'
  exit 1
fi

echo "unit-test-scope($suite): a changed path can reach the $suite suite — running"
exit 0
