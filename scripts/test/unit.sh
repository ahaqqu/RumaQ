#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT_DIR/scripts/lib/quiet.sh"

WORKSPACE="${1:-all}"
shift || true

# --watch is interactive: stream it instead of capturing a log.
interactive=false
for arg in "$@"; do
  case "$arg" in --watch | -w) interactive=true ;; esac
done

run() {
  local label=$1
  shift
  local args=("$@")
  local have_reporter=false
  for arg in "${args[@]}"; do
    case "$arg" in --reporter | --reporter=*) have_reporter=true ;; esac
  done
  $have_reporter || args+=(--reporter=dot)

  if $interactive; then
    (cd "$ROOT_DIR" && exec bunx vp test "${args[@]}")
  fi
  (cd "$ROOT_DIR" && q_run "$label" "test-results/unit-$label.log" bunx vp test "${args[@]}")
}

case "$WORKSPACE" in
  frontend)
    # frontend-dom (api.test.js) runs on the default forks pool — see
    # vite.config.ts (#351): under vmThreads the jsdom window is the VM
    # global, so its unforgeable window.location cannot be redefined.
    run frontend --project frontend --project frontend-dom "$@"
    ;;
  backend)
    run backend --project backend "$@"
    ;;
  all)
    run frontend --project frontend --project frontend-dom "$@"
    run backend --project backend "$@"
    ;;
  *)
    echo "Usage: $0 [frontend|backend|all] [vitest args...]"
    exit 1
    ;;
esac
