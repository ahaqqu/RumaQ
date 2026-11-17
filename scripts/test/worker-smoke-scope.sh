#!/usr/bin/env bash
set -euo pipefail

# Offline guard for the worker-smoke scope rule (ahaqqu/RumaQ#534).
#
# The Worker boot smoke costs a bundle build plus two workerd boots. Docs, a
# skill, an automation test, or Markdown cannot change the bundle built by
# `vp build backend`, so the smoke skips those change sets. Anything else — a
# backend file, a dependency, a workflow step — runs it, and an empty or
# unavailable change set runs it too (the failure mode must be a wasted minute,
# never a broken bundle that merges green).
#
# Offline only: the rule is exercised through --from-stdin, no git, no network.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCOPE="$ROOT_DIR/scripts/github/worker-smoke-scope.sh"
failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ worker-smoke scope)\n' "$1" >&2
  failures=$((failures + 1))
}

# expect <name> <run|skip> <path>...
# Asserts the verdict WORD — stdout's first token with exit 0 (audit M1) —
# not an exit code: skip is a verdict now, not a non-zero exit.
expect() {
  local name=$1 want=$2 out got
  shift 2
  if out="$(printf '%s\n' "$@" | bash "$SCOPE" --from-stdin 2>/dev/null)"; then
    case "$out" in
      run*) got=run ;;
      skip*) got=skip ;;
      *) got="bad-verdict:${out%%[[:space:]]*}" ;;
    esac
  else
    got=error
  fi
  if [ "$got" = "$want" ]; then
    pass "$name"
  else
    fail "$name (want $want, got $got)"
  fi
}

# expect_error <name> <gate args>... — a gate that cannot decide exits
# non-zero and prints NO verdict, so a caller consuming the word fails the
# job instead of skipping (audit M1).
expect_error() {
  local name=$1 out code=0
  shift
  out="$(bash "$SCOPE" "$@" 2>/dev/null </dev/null)" || code=$?
  if [ "$code" -ne 0 ] && [ -z "$out" ]; then
    pass "$name"
  else
    fail "$name (exit $code, stdout: ${out:-<empty>})"
  fi
}

expect 'docs page skips'      skip docs/API.md
expect 'skill skips'          skip .agents/skills/code-audit/SKILL.md
expect 'automation skips'     skip automation/tests/local/e2e/features/smoke.feature
expect 'root markdown skips'  skip README.md
expect 'backend runs'         run  backend/src/apps/api.ts
expect 'contract runs'        run  contract/src/index.ts
expect 'dependency runs'      run  bun.lock
expect 'workflow runs'        run  .github/workflows/ci.yml
expect 'deploy script runs'   run  scripts/deploy.sh
expect 'mixed runs'           run  docs/API.md backend/src/lib/scrape.ts
expect 'markdown beside code' run  backend/src/lib/README.md backend/src/lib/scrape.ts
expect 'empty set runs'       run  ''

# --- the verdict protocol itself (audit M1) ---
expect_error 'bad flag errors' --bogus

if [ "$failures" -eq 0 ]; then
  echo 'worker-smoke scope: ok'
  exit 0
fi

echo "worker-smoke scope: $failures failure(s)" >&2
exit 1
