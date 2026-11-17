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
# Cross-workspace edges the rules must honor (see skippable-paths.txt):
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
#
# The verdict protocol is lib/scope-verdict.sh: stdout "run|skip <why>",
# exit 0; an error prints no verdict and exits non-zero (audit M1).
set -uo pipefail

suite=${1:-}
case "$suite" in
  frontend | backend) ;;
  *)
    echo "unit-test-scope: suite must be 'frontend' or 'backend'" >&2
    exit 2
    ;;
esac
shift || true

. "$(cd "$(dirname "$0")" && pwd)/lib/scope-verdict.sh"

scope_gate_main "unit/$suite" "unit-test-scope($suite)" \
  "change set cannot reach the $suite suite" \
  "a changed path can reach the $suite suite" "$@"
