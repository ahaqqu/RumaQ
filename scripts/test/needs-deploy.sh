#!/usr/bin/env bash
set -euo pipefail

# Offline guard for the production-deploy scope rule
# (scripts/github/needs-deploy.sh).
#
# A push to main deploys the v1 Worker unless every changed path is in the
# gate's no-deploy set. server/ is the v2 package (Phase 2, #763): nothing in
# it can change the frozen v1 Worker, so a server/**-only merge must not
# deploy — while a mixed push (server/ beside anything else) still does, and
# an unknown previous head still deploys (fail safe).
#
# Offline only: each case builds a throwaway repository under mktemp with one
# base commit and one head commit touching exactly the named paths, then asks
# the REAL gate for its verdict word — the git pathspec logic deploy.yml runs.
# No network; the working repository is never touched.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
NEEDS_DEPLOY="$ROOT_DIR/scripts/github/needs-deploy.sh"
failures=0
tmp_roots=()

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ deploy scope)\n' "$1" >&2
  failures=$((failures + 1))
}

cleanup() {
  for dir in ${tmp_roots[@]+"${tmp_roots[@]}"}; do rm -rf "$dir"; done
}
trap cleanup EXIT

# make_repo <dir> <path>... — a base commit, then a head commit that adds
# exactly <path>... (a file holding "x" each). Hooks and signing are off so a
# developer's global git config cannot interfere.
make_repo() {
  local dir=$1 path
  shift
  git -C "$dir" init -q -b main
  git -C "$dir" -c user.name=offline -c user.email=offline@example.invalid \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit -q --allow-empty -m base
  for path in "$@"; do
    mkdir -p "$dir/$(dirname "$path")"
    printf 'x\n' >"$dir/$path"
    git -C "$dir" add -- "$path"
  done
  git -C "$dir" -c user.name=offline -c user.email=offline@example.invalid \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit -q --allow-empty -m head
}

# verdict <dir> <base> — the gate's verdict WORD, run from the repository root
# the way deploy.yml runs it. A gate error shows up as "error", never as a
# verdict.
verdict() {
  local dir=$1 base=$2 out
  out=$(cd "$dir" && bash "$NEEDS_DEPLOY" "$base" HEAD) || out=error
  printf '%s\n' "${out%%[[:space:]]*}"
}

# expect <name> <true|false> <path>...
expect() {
  local name=$1 want=$2 dir base got
  shift 2
  dir=$(mktemp -d)
  tmp_roots+=("$dir")
  make_repo "$dir" "$@"
  base=$(git -C "$dir" rev-parse HEAD~1)
  got=$(verdict "$dir" "$base")
  if [ "$got" = "$want" ]; then
    pass "$name"
  else
    fail "$name (want $want, got $got)"
  fi
}

# --- server/** alone never deploys the v1 Worker ---
expect 'server source alone does not deploy'   false server/src/index.ts
expect 'server manifest alone does not deploy' false server/package.json
expect 'server lockfile alone does not deploy' false server/bun.lock
expect 'server tree alone does not deploy'     false server/src/index.ts server/package.json server/bun.lock server/compose.yaml server/openapi/web-api.json

# --- everything else deploys, exactly as before R1 ---
expect 'docs alone do not deploy'              false docs/API.md README.md
expect 'backend deploys'                       true  backend/src/apps/api.ts
expect 'frontend deploys'                      true  frontend/src/App.tsx
expect 'contract deploys'                      true  contract/src/index.ts
expect 'deploy script deploys'                 true  scripts/deploy.sh
expect 'test script deploys'                   true  scripts/test.sh
expect 'scope table deploys'                   true  scripts/github/skippable-paths.txt
expect 'root manifest deploys'                 true  package.json
expect 'root lockfile deploys'                 true  bun.lock
expect 'unknown path deploys'                  true  some/new/dir/file.xyz

# --- a mixed change set deploys (design §4.2: "a mixed PR gets both") ---
expect 'server beside backend deploys'         true  server/src/index.ts backend/src/apps/api.ts
expect 'server beside scripts deploys'         true  server/src/index.ts scripts/test/unit.sh
expect 'server beside root manifest deploys'   true  server/src/index.ts package.json
expect 'server beside docs does not deploy'    false server/src/index.ts docs/API.md

# --- no change at all does not deploy ---
expect 'no change set does not deploy'         false

# --- an unknown previous head deploys, even for a docs-only push (24-27) ---
dir=$(mktemp -d)
tmp_roots+=("$dir")
make_repo "$dir" docs/API.md README.md
got=$(verdict "$dir" 0000000000000000000000000000000000000000)
if [ "$got" = true ]; then
  pass 'zero base deploys'
else
  fail "zero base deploys (want true, got $got)"
fi

# --- the gate itself: missing arguments are an error, not a verdict ---
out=''
code=0
out=$(bash "$NEEDS_DEPLOY" 2>/dev/null </dev/null) || code=$?
if [ "$code" -ne 0 ] && [ -z "$out" ]; then
  pass 'missing refs error'
else
  fail "missing refs error (exit $code, stdout: ${out:-<empty>})"
fi

if [ "$failures" -eq 0 ]; then
  echo 'deploy scope: ok'
  exit 0
fi

echo "deploy scope: $failures failure(s)" >&2
exit 1
