#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

WORKSPACE="${1:-all}"
shift || true

case "$WORKSPACE" in
  frontend)
    cd "$ROOT_DIR" && bunx vp test --project frontend "$@"
    ;;
  backend)
    cd "$ROOT_DIR" && bunx vp test --project backend "$@"
    ;;
  scraper)
    cd "$ROOT_DIR" && bunx vp test --project scraper "$@"
    ;;
  all)
    cd "$ROOT_DIR" && bunx vp test --project frontend "$@"
    cd "$ROOT_DIR" && bunx vp test --project backend "$@"
    cd "$ROOT_DIR" && bunx vp test --project scraper "$@"
    ;;
  *)
    echo "Usage: $0 [frontend|backend|scraper|all] [vitest args...]"
    exit 1
    ;;
esac
