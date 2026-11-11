#!/usr/bin/env bash
# Deterministic state-bearing inventory for the code-audit skill. Read-only.
# usage: scan.sh <path> [max-evidence-lines]
set -uo pipefail

[ $# -ge 1 ] || { echo "usage: scan.sh <path> [max-evidence-lines]" >&2; exit 2; }
scope=$1
cap=${2:-160}
[ -d "$scope" ] || { echo "not a directory: $scope" >&2; exit 2; }

# Option order matters: includes must come before file excludes. In the other
# order grep drops the include filter and matches every file.
common_dirs=( --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target
  --exclude-dir=dist --exclude-dir=coverage --exclude-dir=test-results
  --exclude-dir=playwright-report --exclude-dir=.wrangler )
source_dirs=( "${common_dirs[@]}" --exclude-dir=__tests__ --exclude-dir=tests )
code=( --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs'
  --include='*.rs' --include='*.sh' --include='*.sql' --include='*.py'
  --include='*.go' --include='*.java' --include='*.kt' --include='*.nix' )
test_files=( --include='*.test.ts' --include='*.test.tsx' --include='*.test.js'
  --include='*.test.mjs' --include='*.spec.ts' --include='*.spec.js' )
gen=( --exclude='*.gen.ts' --exclude=openapi.json )
src_excl=( "${gen[@]}" --exclude='*.test.*' --exclude='*.spec.*' )

strong='\b(status|claim|lease|retry|backoff|attempt|reap|expire|expiry|ttl|timeout|idempot|optimistic|reservation|cutoff|grace|pending|queued|running|succeeded|cancelled|transition)s?\b'
weak='\b(state|step|stage|version|enabled|disabled|cron|schedule|lock|flag)s?\b|(setTimeout|setInterval|is[A-Z][A-Za-z]*|has[A-Z][A-Za-z]*|can[A-Z][A-Za-z]*)'

rank() {
  local pat=$1
  shift
  grep -rIcE "$pat" "$scope" "$@" 2>/dev/null \
    | awk -F: '$NF + 0 > 0 { n = $NF; sub(/:[0-9]+$/, "", $0); print n"\t"$0 }' \
    | sort -rn 2>/dev/null | head -20
}

files=$(grep -rIlE "$strong" "$scope" "${code[@]}" "${src_excl[@]}" "${source_dirs[@]}" 2>/dev/null | wc -l)
src=$(rank "$strong" "${code[@]}" "${src_excl[@]}" "${source_dirs[@]}")
tst=$(rank "$strong" "${test_files[@]}" "${gen[@]}" "${common_dirs[@]}")
weak_rank=$(rank "$weak" "${code[@]}" "${src_excl[@]}" "${source_dirs[@]}")
evidence=$(grep -rnIE "$strong" "$scope" "${code[@]}" "${src_excl[@]}" "${source_dirs[@]}" 2>/dev/null \
  | sed 's/[[:space:]]\+/ /g' 2>/dev/null | cut -c1-180 2>/dev/null | head -n "$cap")

# One write, so a reader that stops early cannot produce broken-pipe noise.
{ printf '%s\n' \
  "# scan: $scope   (source files with strong signal: $files)" "" \
  "== strong signal, source" "$src" "" \
  "== strong signal, tests (transition evidence)" "$tst" "" \
  "== weak signal, source" "$weak_rank" "" \
  "== evidence (source, first $cap)" "$evidence"; } 2>/dev/null
