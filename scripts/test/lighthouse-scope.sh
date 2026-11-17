#!/usr/bin/env bash
set -euo pipefail

# Offline guard for the Lighthouse scope rule.
#
# Lighthouse audits frontend/dist, built from frontend/ plus the root
# toolchain. Docs, a skill, an automation test, Markdown, backend/, contract/,
# codegen tools, and scripts/ except scripts/build.sh cannot reach that
# bundle, so the audit skips those change sets. Anything else — a frontend
# file, a dependency, a workflow step, scripts/build.sh — runs it, and an
# empty or unavailable change set runs it too (the failure mode must be a
# wasted half-minute, never a performance or accessibility regression that
# merges green).
#
# Offline only: the rule is exercised through --from-stdin, no git, no network.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCOPE="$ROOT_DIR/scripts/github/lighthouse-scope.sh"
failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ lighthouse-scope)\n' "$1" >&2
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

expect 'docs page skips'        skip docs/API.md
expect 'skill skips'            skip .agents/skills/code-audit/SKILL.md
expect 'automation skips'       skip automation/tests/local/e2e/features/smoke.feature
expect 'root markdown skips'    skip README.md
expect 'backend source skips'   skip backend/src/apps/api.ts
expect 'contract source skips'  skip contract/src/index.ts
expect 'codegen tool skips'     skip tools/codegen/src/main.ts
expect 'helper script skips'    skip scripts/style.sh
expect 'ci script skips'        skip scripts/github/ci.sh
expect 'backend markdown skips' skip backend/src/lib/README.md backend/src/lib/scrape.ts
expect 'build script runs'      run  scripts/build.sh
expect 'frontend source runs'   run  frontend/src/App.tsx
expect 'frontend config runs'   run  frontend/vite.config.js
expect 'generated client runs'  run  frontend/src/lib/api-client/index.ts
expect 'lockfile runs'          run  bun.lock
expect 'root manifest runs'     run  package.json
expect 'workflow runs'          run  .github/workflows/ci.yml
expect 'lighthouse config runs' run  .lighthouserc.json
expect 'unknown path runs'      run  LICENSE
expect 'frontend beside docs runs' run docs/API.md frontend/src/App.tsx
expect 'mixed runs'             run  docs/API.md scripts/build.sh
expect 'empty set runs'         run  ''

# --- the verdict protocol itself (audit M1) ---
expect_error 'bad flag errors' --bogus

if [ "$failures" -eq 0 ]; then
  echo 'lighthouse-scope: ok'
  exit 0
fi

echo "lighthouse-scope: $failures failure(s)" >&2
exit 1
