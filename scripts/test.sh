#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUITE="${1:-all}"
shift || true

case "$SUITE" in
  unit)
    exec "$ROOT_DIR/scripts/test/unit.sh" "$@"
    ;;
  automation-local)
    exec "$ROOT_DIR/scripts/test/automation-local.sh" "$@"
    ;;
  automation-live)
    exec "$ROOT_DIR/scripts/test/automation-live.sh" "$@"
    ;;
  deploy)
    # Offline guard for the deploy surface (ahaqqu/RumaQ#456): CI must never
    # write the operator-owned HAQITA_INGEST_SECRET Worker secret.
    exec "$ROOT_DIR/scripts/test/deploy-secrets.sh" "$@"
    ;;
  freshness)
    # Offline guard for the price-freshness probe (ahaqqu/RumaQ#536): the
    # consecutive-failed-run branch must fire with zero observations, and the
    # staleness branch must keep its behaviour. Canned responses, no network.
    exec "$ROOT_DIR/scripts/test/price-freshness.sh" "$@"
    ;;
  smoke-scope)
    # Offline guard for the worker-smoke scope rule: docs, skills, automation
    # tests and Markdown cannot change the bundle, so the workerd boot skips
    # them; anything else runs it.
    exec "$ROOT_DIR/scripts/test/worker-smoke-scope.sh" "$@"
    ;;
  lighthouse-scope)
    # Offline guard for the Lighthouse scope rule: docs, backend, contract,
    # codegen tools and most scripts cannot reach the frontend bundle, so the
    # audit skips them; a frontend, lockfile, or build-script change runs it.
    exec "$ROOT_DIR/scripts/test/lighthouse-scope.sh" "$@"
    ;;
  unit-test-scope)
    # Offline guard for the unit-test scope rules: a suite skips change sets
    # that cannot reach its workspace, with the parity edge (backend/src/
    # plugins/ runs the frontend suite) and contract/ running the backend.
    exec "$ROOT_DIR/scripts/test/unit-test-scope.sh" "$@"
    ;;
  automation-stack)
    # Offline guard for the automation Docker stack (#356): per-invocation
    # project identity, toolchain digest, readiness classification, backoff
    # and label teardown — shell shims only, no Docker, no network.
    exec "$ROOT_DIR/scripts/test/automation-stack.sh" "$@"
    ;;
  all)
    "$ROOT_DIR/scripts/test/deploy-secrets.sh" "$@"
    "$ROOT_DIR/scripts/test/worker-smoke-scope.sh" "$@"
    "$ROOT_DIR/scripts/test/lighthouse-scope.sh" "$@"
    "$ROOT_DIR/scripts/test/unit-test-scope.sh" "$@"
    "$ROOT_DIR/scripts/test/price-freshness.sh" "$@"
    "$ROOT_DIR/scripts/test/automation-stack.sh" "$@"
    "$ROOT_DIR/scripts/test/unit.sh" "$@"
    "$ROOT_DIR/scripts/test/automation-local.sh" "$@"
    "$ROOT_DIR/scripts/test/automation-live.sh" "$@"
    ;;
  *)
    echo "Usage: $0 [unit|automation-local|automation-live|deploy|freshness|smoke-scope|lighthouse-scope|unit-test-scope|automation-stack|all]"
    exit 1
    ;;
esac
