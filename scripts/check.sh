#!/usr/bin/env bash
# Pre-push gate for agents and humans: regenerate the API docs and the typed
# API client, then fail on drift.
#
# Styling is owned by the commit hook, and the full CI gate stays on GitHub —
# do not run scripts/github/ci.sh by hand (see the pr-creation skill).
#
#   ./scripts/check.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT_DIR/scripts/lib/quiet.sh"

cd "$ROOT_DIR"
failures=0

q_run "docs drift" "test-results/check-docs.log" \
  bash -c 'bash scripts/docs.sh && git diff --exit-code docs/API.md' \
  || failures=$((failures + 1))

q_run "codegen drift" "test-results/check-codegen.log" \
  bash -c 'bunx vp run api:codegen && git diff --exit-code frontend/openapi.json frontend/src/lib/api-client' \
  || failures=$((failures + 1))

if [ "$failures" -eq 0 ]; then
  echo "check: ok"
  exit 0
fi

echo "check: $failures gate(s) failed — the failing lines are above, the full output is in test-results/" >&2
exit 1
