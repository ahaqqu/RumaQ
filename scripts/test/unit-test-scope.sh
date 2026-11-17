#!/usr/bin/env bash
set -euo pipefail

# Offline guard for the unit-test scope rules.
#
# The frontend suite tests frontend/src; the backend suite tests backend/src
# with contract/. Docs, a skill, an automation test, Markdown, codegen tools,
# and the other workspace's sources cannot reach a suite, so those change sets
# skip it. Anything else — a file in the tested workspace, a dependency, the
# test plumbing under scripts/, a workflow step — runs it, and an empty or
# unavailable change set runs it too (the failure mode must be a wasted
# minute, never a regression that merges green).
#
# Named cross-workspace edge: frontend/src/plugins/registry.test.js imports
# backend's plugins/manifests.js (plugin parity, plan §4.3), so
# backend/src/plugins/ always runs the frontend suite.
#
# Offline only: the rule is exercised through --from-stdin, no git, no network.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCOPE="$ROOT_DIR/scripts/github/unit-test-scope.sh"
failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ unit-test-scope)\n' "$1" >&2
  failures=$((failures + 1))
}

# expect <suite> <name> <run|skip> <path>...
# Asserts the verdict WORD — stdout's first token with exit 0 (audit M1) —
# not an exit code: skip is a verdict now, not a non-zero exit.
expect() {
  local suite=$1 name=$2 want=$3 out got
  shift 3
  if out="$(printf '%s\n' "$@" | bash "$SCOPE" "$suite" --from-stdin 2>/dev/null)"; then
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

# expect_error <name> <gate args>... — the protocol case the contract exists
# for: a gate that cannot decide (bad usage) exits non-zero and prints NO
# verdict, so a caller consuming the word fails the job instead of skipping.
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

# --- frontend suite ---
expect frontend 'docs page skips'        skip docs/API.md
expect frontend 'skill skips'            skip .agents/skills/code-audit/SKILL.md
expect frontend 'automation skips'       skip automation/tests/local/e2e/features/smoke.feature
expect frontend 'root markdown skips'    skip README.md
expect frontend 'backend source skips'   skip backend/src/apps/api.ts
expect frontend 'contract source skips'  skip contract/src/index.ts
expect frontend 'codegen tool skips'     skip tools/codegen/src/main.ts
expect frontend 'backend markdown skips' skip backend/src/lib/README.md backend/src/lib/scrape.ts
expect frontend 'backend plugins run'    run  backend/src/plugins/manifests.ts
expect frontend 'backend plugins beside backend source run' \
  run backend/src/plugins/manifests.ts backend/src/lib/scrape.ts
expect frontend 'frontend source runs'   run  frontend/src/App.tsx
expect frontend 'parity test runs'       run  frontend/src/plugins/registry.test.js
expect frontend 'lockfile runs'          run  bun.lock
expect frontend 'root manifest runs'     run  package.json
expect frontend 'test config runs'       run  vite.config.ts
expect frontend 'workflow runs'          run  .github/workflows/ci.yml
expect frontend 'test runner runs'       run  scripts/test/unit.sh
expect frontend 'unknown path runs'      run  LICENSE
expect frontend 'frontend beside docs runs' run docs/API.md frontend/src/App.tsx
expect frontend 'empty set runs'         run  ''

# --- backend suite ---
expect backend 'docs page skips'        skip docs/API.md
expect backend 'skill skips'            skip .agents/skills/code-audit/SKILL.md
expect backend 'automation skips'       skip automation/tests/local/api/steps/purchases.steps.js
expect backend 'frontend source skips'  skip frontend/src/App.tsx
expect backend 'codegen tool skips'     skip tools/codegen/src/main.ts
expect backend 'frontend beside docs skips' skip docs/API.md frontend/src/App.tsx
expect backend 'backend source runs'    run  backend/src/apps/api.ts
expect backend 'backend plugins run'    run  backend/src/plugins/manifests.ts
expect backend 'contract source runs'   run  contract/src/index.ts
expect backend 'lockfile runs'          run  bun.lock
expect backend 'test config runs'       run  vite.config.ts
expect backend 'test runner runs'       run  scripts/test/unit.sh
expect backend 'empty set runs'         run  ''

# --- the verdict protocol itself (audit M1) ---
expect_error 'bad suite errors' bad-suite
expect_error 'bad flag errors'  frontend --bogus

if [ "$failures" -eq 0 ]; then
  echo 'unit-test-scope: ok'
  exit 0
fi

echo "unit-test-scope: $failures failure(s)" >&2
exit 1
