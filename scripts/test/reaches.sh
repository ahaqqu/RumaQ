#!/usr/bin/env bash
set -euo pipefail

# Offline guard for the generated-artifact reach rules
# (scripts/github/reaches.sh).
#
# The docs check and the codegen check regenerate docs/API.md and the typed
# client from the backend routes, the contract and the codegen tool, so a
# change set outside them must skip both. The dependency audit only depends on
# the manifests and the lockfile. Anything unknown runs (fail safe), and an
# unavailable change set runs too — a wasted second, never a missed drift.
#
# `api-server` regenerates the v2 OpenAPI documents for `server/` and
# `scripts/docs.sh` only; `deps-server` audits `server/` for its own manifest
# and lockfile only; the v1 `api`/`deps` targets do not see `server/`, so
# nothing under it runs them.
#
# Offline only: the rule is exercised through --from-stdin, no git, no network.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REACHES="$ROOT_DIR/scripts/github/reaches.sh"
failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ artifact reach)\n' "$1" >&2
  failures=$((failures + 1))
}

# expect <name> <run|skip> <path>...
# Asserts the verdict WORD — stdout's first token with exit 0, matched
# exactly (audit M1) — not an exit code: skip is a verdict now, not a
# non-zero exit, and a typo'd word is an error, not a run.
expect() {
  local name=$1 target=$2 want=$3 out got
  shift 3
  if out="$(printf '%s\n' "$@" | bash "$REACHES" "$target" --from-stdin 2>/dev/null)"; then
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

# expect_error <name> <gate args>... — a gate that cannot decide exits
# non-zero and prints NO verdict, so a caller consuming the word fails the
# job instead of skipping (audit M1).
expect_error() {
  local name=$1 out code=0
  shift
  out="$(bash "$REACHES" "$@" 2>/dev/null </dev/null)" || code=$?
  if [ "$code" -ne 0 ] && [ -z "$out" ]; then
    pass "$name"
  else
    fail "$name (exit $code, stdout: ${out:-<empty>})"
  fi
}

expect 'api: backend route runs'        api run  backend/src/apps/api.ts
expect 'api: contract runs'             api run  contract/src/index.ts
expect 'api: codegen tool runs'         api run  tools/codegen/src/index.ts
expect 'api: generated docs run'        api run  docs/API.md
expect 'api: lockfile runs'             api run  bun.lock
expect 'api: root manifest runs'        api run  package.json
expect 'api: docs skip'                 api skip docs/FRONTEND_CONVENTIONS.md
expect 'api: frontend skips'            api skip frontend/src/pages/Home.jsx
expect 'api: scripts skip'              api skip scripts/deploy.sh
expect 'deps: lockfile runs'            deps run bun.lock
expect 'deps: workspace manifest runs'  deps run backend/package.json
expect 'deps: source skips'             deps skip backend/src/apps/api.ts
expect 'deps: docs skip'                deps skip docs/API.md
expect 'unknown path runs api'          api run  tools/whatever/x.ts
expect 'empty set runs api'             api run  ''
expect 'empty set runs deps'            deps run ''

# --- server/ (v2) never reaches the v1 generators; the v2 targets read server/ alone ---
expect 'api: server source skips'            api skip server/src/entrypoints/web-api/main.ts
expect 'api: server manifest skips'          api skip server/package.json
expect 'api: server lockfile skips'          api skip server/bun.lock
expect 'api: server beside backend runs'     api run  server/src/index.ts backend/src/apps/api.ts
expect 'api: docs script runs'               api run  scripts/docs.sh
expect 'api: frontend manifest runs'         api run  frontend/package.json
expect 'api: backend manifest runs'          api run  backend/package.json
expect 'api: contract manifest runs'         api run  contract/package.json
expect 'api: codegen manifest runs'          api run  tools/codegen/package.json
# An unknown workspace's manifest still runs the v1 targets (fail safe): the
# v1 input patterns are unchanged, server/ is excluded on the input side.
expect 'api: unknown workspace manifest runs' api run  web/package.json
expect 'api-server: server source runs'      api-server run  server/src/entrypoints/openapi.ts
expect 'api-server: docs script runs'        api-server run  scripts/docs.sh
expect 'api-server: server manifest runs'    api-server run  server/package.json
expect 'api-server: backend source skips'    api-server skip backend/src/apps/api.ts
expect 'api-server: root manifest skips'     api-server skip package.json
expect 'api-server: unknown path skips'      api-server skip some/new/dir/file.xyz
expect 'api-server: empty set runs'          api-server run  ''
expect 'deps: server lockfile skips'         deps skip server/bun.lock
expect 'deps: server manifest skips'         deps skip server/package.json
expect 'deps: frontend manifest runs'        deps run  frontend/package.json
expect 'deps: contract manifest runs'        deps run  contract/package.json
expect 'deps: codegen manifest runs'         deps run  tools/codegen/package.json
expect 'deps: unknown workspace manifest runs' deps run  web/package.json
expect 'deps-server: server lockfile runs'   deps-server run  server/bun.lock
expect 'deps-server: server manifest runs'   deps-server run  server/package.json
expect 'deps-server: server source skips'    deps-server skip server/src/index.ts
expect 'deps-server: root lockfile skips'    deps-server skip bun.lock
expect 'deps-server: root manifest skips'    deps-server skip package.json
expect 'deps-server: empty set runs'         deps-server run  ''

# --- the verdict protocol itself (audit M1) ---
expect_error 'bad target errors' bad-target
expect_error 'bad flag errors'   api --bogus

if [ "$failures" -eq 0 ]; then
  echo 'artifact reach: ok'
  exit 0
fi

echo "artifact reach: $failures failure(s)" >&2
exit 1
