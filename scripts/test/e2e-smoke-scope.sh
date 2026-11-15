#!/usr/bin/env bash
set -euo pipefail

# Offline guard for the PR E2E smoke scope rule (#657 phase 2).
#
# The smoke costs a stack start plus the three @smoke scenarios (a pull is
# ~2-2.5 min, a cold build ~5.5). Docs, a skill, Markdown, LICENSE,
# .gitignore and issue/PR templates cannot change what the smoke exercises,
# so those change sets skip. Anything else — frontend, backend, contract,
# the automation harness itself, a lockfile, .gitattributes, the workflow,
# or any unknown path — runs it, and an empty or unavailable change set runs
# it too (fail safe: a wasted few minutes, never a missed regression, and a
# required check always reports).
#
# Offline only: the rule is exercised through --from-stdin, no git, no network.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCOPE="$ROOT_DIR/scripts/github/e2e-smoke-scope.sh"
failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ e2e-smoke scope)\n' "$1" >&2
  failures=$((failures + 1))
}

# expect <name> <run|skip> <path>...
expect() {
  local name=$1 want=$2 code=0 got
  shift 2
  printf '%s\n' "$@" | bash "$SCOPE" --from-stdin >/dev/null 2>&1 || code=$?
  got=run
  [ "$code" -ne 0 ] && got=skip
  if [ "$got" = "$want" ]; then
    pass "$name"
  else
    fail "$name (want $want, got $got)"
  fi
}

expect 'docs page skips'        skip docs/TEST_STRATEGY.md
expect 'skill skips'            skip .agents/skills/code-audit/SKILL.md
expect 'root markdown skips'    skip README.md
expect 'license skips'          skip LICENSE
expect 'gitignore skips'        skip .gitignore
expect 'issue template skips'   skip .github/ISSUE_TEMPLATE/bug_report.md
expect 'pr template skips'      skip .github/PULL_REQUEST_TEMPLATE.md
expect 'docs-only set skips'    skip docs/QA.md docs/TEST_STRATEGY.md

expect 'frontend runs'          run  frontend/src/pages/AdminReview.jsx
expect 'backend runs'           run  backend/src/apps/api.ts
expect 'contract runs'          run  contract/src/index.ts
expect 'automation harness runs' run automation/docker-compose.yml
expect 'feature file runs'      run  automation/tests/local/e2e/features/smoke.feature
expect 'lockfile runs'          run  bun.lock
expect 'test entrypoint runs'   run  scripts/test.sh
expect 'gitattributes runs'     run  .gitattributes
expect 'workflow runs'          run  .github/workflows/pr-e2e-smoke.yml
expect 'dockerignore runs'      run  .dockerignore
expect 'unknown path runs'      run  some/new/dir/file.xyz
expect 'mixed docs+code runs'   run  docs/API.md backend/src/lib/scrape.ts
expect 'markdown beside code'   run  backend/src/lib/README.md backend/src/lib/scrape.ts
expect 'empty set runs'         run  ''

if [ "$failures" -eq 0 ]; then
  echo 'e2e-smoke scope: ok'
  exit 0
fi

echo "e2e-smoke scope: $failures failure(s)" >&2
exit 1
