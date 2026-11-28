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
# The v2 suite (`server`) runs `bun test` from `server/`: `server/`,
# `scripts/`, root manifests and unknown paths run it; docs, the v1 workspaces
# and codegen tools skip it. `server/` itself skips the two v1 suites.
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

# expect <name> <run|skip> <path>...
# Asserts the verdict WORD — stdout's first token with exit 0, matched
# exactly (audit M1) — not an exit code: skip is a verdict now, not a
# non-zero exit, and a typo'd word is an error, not a run.
expect() {
  local suite=$1 name=$2 want=$3 out got
  shift 3
  if out="$(printf '%s\n' "$@" | bash "$SCOPE" "$suite" --from-stdin 2>/dev/null)"; then
    # The verdict is the WORD (first token), matched exactly, the same way
    # every production consumer reads it (audit M1).
    got=${out%%[[:space:]]*}
    case "$got" in
      run | skip) ;;
      *) got="bad-verdict:$got" ;;
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
expect frontend 'server source skips'      skip server/src/entrypoints/web-api/main.ts
expect frontend 'server beside docs skips' skip docs/API.md server/package.json
expect frontend 'server beside frontend source runs' \
  run server/src/index.ts frontend/src/App.tsx
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
expect backend 'server source skips'       skip server/src/platform/db/sql.ts
expect backend 'server beside backend source runs' \
  run server/src/index.ts backend/src/apps/api.ts
expect backend 'empty set runs'         run  ''

# --- server suite (v2): server/, scripts/, root manifests and unknown paths
# run it; docs, the v1 workspaces and codegen tools cannot reach it ---
expect server 'server source runs'         run  server/src/index.ts
expect server 'server lockfile runs'       run  server/bun.lock
expect server 'test runner runs'           run  scripts/test/unit.sh
expect server 'workflow runs'              run  .github/workflows/ci.yml
expect server 'root manifest runs'         run  package.json
expect server 'unknown path runs'          run  LICENSE
expect server 'docs page skips'            skip docs/API.md
expect server 'skill skips'                skip .agents/skills/code-audit/SKILL.md
expect server 'automation skips'           skip automation/docker-compose.yml
expect server 'root markdown skips'        skip README.md
expect server 'backend source skips'       skip backend/src/apps/api.ts
expect server 'frontend source skips'      skip frontend/src/App.tsx
expect server 'contract source skips'      skip contract/src/index.ts
expect server 'codegen tool skips'         skip tools/codegen/src/main.ts
expect server 'docs beside server runs'    run  docs/API.md server/src/index.ts
expect server 'empty set runs'             run  ''

# --- the verdict protocol itself (audit M1) ---
expect_error 'bad suite errors' bad-suite
expect_error 'bad flag errors'  frontend --bogus

# expect_error against an unreadable skippable table — the machine table's
# error row ("bad list"): the gate must fail, never fall back to a silent
# run. Pins scope_gate_main for all four gates, which share this table.
skippable_table="$ROOT_DIR/scripts/github/skippable-paths.txt"
mv "$skippable_table" "$skippable_table.offline-guard"
out=''
code=0
# A non-empty change set: the empty-set fail-safe runs before the table is
# consulted, so only a real decision exercises the unreadable-table error.
out="$(printf 'backend/src/apps/api.ts\n' | bash "$SCOPE" frontend --from-stdin 2>/dev/null)" || code=$?
mv "$skippable_table.offline-guard" "$skippable_table"
if [ "$code" -ne 0 ] && [ -z "$out" ]; then
  pass 'unreadable table errors'
else
  fail "unreadable table errors (exit $code, stdout: ${out:-<empty>})"
fi

if [ "$failures" -eq 0 ]; then
  echo 'unit-test-scope: ok'
  exit 0
fi

echo "unit-test-scope: $failures failure(s)" >&2
exit 1
