#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Forward every argument (--build, --no-build, --down, ...) to the real runner.
# This wrapper is only a thin entrypoint: the inner script owns the usage
# contract and rejects unknown flags loudly. Dropping args here would silently
# start the full Docker suite instead of the requested mode.
exec "$ROOT_DIR/automation/scripts/test-local.sh" "$@"
