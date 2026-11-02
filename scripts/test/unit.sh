#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

WORKSPACE="${1:-all}"
shift || true

case "$WORKSPACE" in
  frontend)
    # frontend-dom (api.test.js) runs on the default forks pool — see
    # vite.config.ts (#351): under vmThreads the jsdom window is the VM
    # global, so its unforgeable window.location cannot be redefined.
    cd "$ROOT_DIR" && bunx vp test --project frontend --project frontend-dom "$@"
    ;;
  backend)
    cd "$ROOT_DIR" && bunx vp test --project backend "$@"
    ;;
  all)
    cd "$ROOT_DIR" && bunx vp test --project frontend --project frontend-dom "$@"
    cd "$ROOT_DIR" && bunx vp test --project backend "$@"
    ;;
  *)
    echo "Usage: $0 [frontend|backend|all] [vitest args...]"
    exit 1
    ;;
esac
