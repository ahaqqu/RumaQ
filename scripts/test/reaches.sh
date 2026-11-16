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
# Offline only: the rule is exercised through --from-stdin, no git, no network.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REACHES="$ROOT_DIR/scripts/github/reaches.sh"
failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ artifact reach)\n' "$1" >&2
  failures=$((failures + 1))
}

# expect <name> <api|deps> <run|skip> <path>...
expect() {
  local name=$1 target=$2 want=$3 code=0 got
  shift 3
  printf '%s\n' "$@" | bash "$REACHES" "$target" --from-stdin >/dev/null 2>&1 || code=$?
  got=run
  [ "$code" -ne 0 ] && got=skip
  if [ "$got" = "$want" ]; then
    pass "$name"
  else
    fail "$name (want $want, got $got)"
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

if [ "$failures" -eq 0 ]; then
  echo 'artifact reach: ok'
  exit 0
fi

echo "artifact reach: $failures failure(s)" >&2
exit 1
