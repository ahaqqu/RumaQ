#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Resolve the change set once: the gates below read CHANGED_PATHS instead of
# repeating the fetch, and on a shallow checkout the first resolution is the
# expensive one (it deepens to reach the merge base).
CHANGED_PATHS=$(bash "$ROOT_DIR/scripts/github/changed-paths.sh" || true)
export CHANGED_PATHS

# Scope gates answer "run" or "skip" as the first word of stdout and must
# never be consumed by an if: an errored gate (bad usage, a crash) exits
# non-zero and fails the job instead of reading as a skip (audit M1).
# scope_gate prints the gate's reason line to the log and echoes only the
# verdict word.
scope_gate() {
  local gate=$1 out
  shift
  out="$(bash "$ROOT_DIR/scripts/github/$gate" "$@")" || {
    echo "  scope gate $gate errored — failing the job" >&2
    return 1
  }
  case "$out" in
    run* | skip*)
      printf '  %s\n' "$out" >&2
      printf '%s\n' "${out%%[[:space:]]*}"
      ;;
    *)
      echo "  scope gate $gate printed no verdict: $out" >&2
      return 1
      ;;
  esac
}

echo "=== CI: deploy secret guard (#456) ==="
# Offline: asserts the CI deploy never writes the operator-owned
# HAQITA_INGEST_SECRET and still manages exactly the four gateway secrets.
# A re-asserted stale copy silently clobbers the rotated Worker value and 401s
# every internal endpoint (ahaqqu/RumaQ#456).
"$ROOT_DIR/scripts/test.sh" deploy

echo "=== CI: price-freshness probe guard (#536) ==="
# Offline: runs the real probe script against canned responses. The
# consecutive-failed-run branch must fire with zero observations (a dead
# pipeline must not read as "go-live pending") and the staleness branch must
# keep its behaviour.
"$ROOT_DIR/scripts/test.sh" freshness

echo "=== CI: automation Docker stack guard (#356) ==="
# Offline: asserts the per-invocation project identity, toolchain digest,
# readiness probe classification, backoff schedule and label teardown rules
# that keep source edits image-free and parallel runs collision-free. Shell
# shims only — no Docker daemon, no network.
"$ROOT_DIR/scripts/test.sh" automation-stack

echo "=== CI: fast E2E smoke subset guard (#657) ==="
# Offline: pins the @smoke set to 3-5 scenarios with one anchor per
# smoke/add-receipt/prices-explorer feature, and rejects a tag on a Feature,
# Background, Scenario Outline or Examples line — so the fast mode cannot
# silently grow, shrink or lose a risk class between reviews.
"$ROOT_DIR/scripts/test.sh" e2e-smoke

echo "=== CI: PR smoke scope guard (#657) ==="
# Offline: the PR E2E smoke workflow skips docs/skill/Markdown/meta change
# sets and runs everything else (fail safe). This guard pins that rule the
# same way worker-smoke-scope is pinned.
"$ROOT_DIR/scripts/test.sh" e2e-smoke-scope

echo "=== CI: unit-test scope guard ==="
# Offline: pins the rule unit-test-scope.sh applies — skip sets, the parity
# edge, the fail-safe empty set. CI must execute the policy that decides
# whether the suites run: a guard that never fires lets the rule change
# unnoticed (audit S2).
"$ROOT_DIR/scripts/test.sh" unit-test-scope

echo "=== CI: lighthouse scope guard ==="
# Offline: pins the rule lighthouse-scope.sh applies, for both the ci.sh
# build decision below and ci.yml's Lighthouse step (audit S3).
"$ROOT_DIR/scripts/test.sh" lighthouse-scope

echo "=== CI: style check ==="
bash "$ROOT_DIR/scripts/style.sh" --check

echo "=== CI: docs check ==="
# The generated API docs depend on the backend routes, the contract and the
# codegen tool; a change set outside them cannot alter the output.
docs_verdict=$(scope_gate reaches.sh api) || exit 1
case $docs_verdict in
  run)
    bash "$ROOT_DIR/scripts/docs.sh"
    git diff --exit-code docs/API.md
    ;;
  skip) echo "  skip  docs check for this change set" ;;
esac

echo "=== CI: API client codegen check ==="
# Regenerate the OpenAPI spec + typed client schema and fail on drift between
# the backend routes and the committed frontend artifacts.
codegen_verdict=$(scope_gate reaches.sh api) || exit 1
case $codegen_verdict in
  run)
    bunx vp run api:codegen
    git diff --exit-code frontend/openapi.json frontend/src/lib/api-client
    ;;
  skip) echo "  skip  codegen check for this change set" ;;
esac

echo "=== CI: frontend tests ==="
# Scope: a change set that cannot reach the frontend suite skips it — docs,
# the backend workspace outside the parity edge (backend/src/plugins/ feeds
# the frontend parity test), contract, codegen tools. The rule is
# offline-tested in scripts/test/unit-test-scope.sh (run above, audit S2) and
# it fails safe: an unavailable change set runs the suite.
frontend_verdict=$(scope_gate unit-test-scope.sh frontend) || exit 1
case $frontend_verdict in
  run) "$ROOT_DIR/scripts/test.sh" unit frontend --coverage ;;
  skip) echo "  skip  frontend tests for this change set" ;;
esac

echo "=== CI: backend tests ==="
# Scope: mirrors the frontend rule — docs, the frontend workspace, codegen
# tools skip; backend, contract and anything unknown run.
backend_verdict=$(scope_gate unit-test-scope.sh backend) || exit 1
case $backend_verdict in
  run) "$ROOT_DIR/scripts/test.sh" unit backend --coverage ;;
  skip) echo "  skip  backend tests for this change set" ;;
esac

echo "=== CI: audit ==="
# Only a manifest or lockfile change can alter the installed tree.
audit_verdict=$(scope_gate reaches.sh deps) || exit 1
case $audit_verdict in
  run) bun audit --audit-level=critical ;;
  skip) echo "  skip  dependency audit for this change set" ;;
esac

echo "=== CI: build ==="
# Build only when something downstream can use the artifact: the Worker boot
# smoke and the Lighthouse audit each have their own gate, so the build runs
# whenever either of them will. Each verdict is read under the M1 contract —
# an errored gate fails the job, it never reads as a skip.
smoke_verdict=$(scope_gate worker-smoke-scope.sh) || exit 1
lighthouse_verdict=$(scope_gate lighthouse-scope.sh) || exit 1
if [ "$smoke_verdict" = run ] || [ "$lighthouse_verdict" = run ]; then
  bash "$ROOT_DIR/scripts/build.sh"

  echo "=== CI: bundle size budget ==="
  node "$ROOT_DIR/scripts/ci/bundle-budget.mjs"
else
  echo "  skip  build and bundle budget for this change set"
fi

echo "=== CI: worker boot smoke (workerd) ==="
# Boots the real bundle in workerd and asserts /api/health (#534). This lives
# in ci.sh, not in ci.yml, so the main-push ci job in deploy.yml runs the same
# gate before deploy — PR checks and main CI stay one contract.
#
# Scope: a change set that cannot reach the bundle (docs, a skill, an
# automation test, Markdown) skips it. The rule is offline-tested here and in
# scripts/test/worker-smoke-scope.sh, and it fails safe: an unavailable change
# set runs the smoke.
"$ROOT_DIR/scripts/test.sh" smoke-scope
smoke_verdict=$(scope_gate worker-smoke-scope.sh) || exit 1
case $smoke_verdict in
  run) bash "$ROOT_DIR/scripts/github/worker-boot-smoke.sh" ;;
  skip) echo "worker boot smoke: skipped for this change set" ;;
esac

echo "=== CI: validate Worker config ==="
# Builds the Worker with backend/cloudflare.config.ts and runs cf's checks
# without uploading (worker name/bindings are computed by the config).
# cf deploy must run next to cloudflare.config.ts so it finds the project.
# Still token-gated (audit S4, deferred): a secret-less PR skips it.
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  config_verdict=$(scope_gate worker-smoke-scope.sh) || exit 1
  case $config_verdict in
    run)
      cd "$ROOT_DIR/backend"
      node "$ROOT_DIR/node_modules/cf/bin/cf" deploy --dry-run
      cd "$ROOT_DIR"
      ;;
    skip) echo "  skip  change set cannot reach the Worker — config validation skipped." ;;
  esac
else
  echo "  skip  CLOUDFLARE_API_TOKEN not set — Worker config validation skipped."
fi

echo "=== CI: passed ==="
