#!/usr/bin/env bash
set -euo pipefail

# Clean up Cloudflare resources created for a feature branch preview.
# Usage: cleanup-branch.sh <branch-name>

BRANCH_NAME="${1:-}"
if [[ -z $BRANCH_NAME ]]; then
  echo "Error: branch name required"
  echo "Usage: $0 <branch-name>"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SANITIZED=$(echo "$BRANCH_NAME" | sed 's/[^a-zA-Z0-9-]/-/g')
WORKER_NAME="rumaq-api-${SANITIZED}"
CF="$ROOT_DIR/node_modules/cf/bin/cf"

# Fork PRs get no Actions secrets; skip instead of failing on auth.
if [[ -z ${CLOUDFLARE_API_TOKEN:-} ]]; then
  echo "==> CLOUDFLARE_API_TOKEN not set — skipping cleanup (fork PR or missing secret)"
  exit 0
fi

echo "==> Cleaning up branch: ${BRANCH_NAME}"
echo "    Worker: ${WORKER_NAME}"

list_workers() {
  node "$CF" workers list | node -e '
    let d = "";
    process.stdin.on("data", c => (d += c)).on("end", () => {
      for (const w of JSON.parse(d)) console.log(w.name);
    });
  '
}

# Worker name/bindings live in backend/cloudflare.config.ts; pass the name
# explicitly for deletion.
if ! list_workers | grep -qxF "$WORKER_NAME"; then
  echo "  -   No preview Worker deployed for this branch"
  echo "==> Cleanup complete"
  exit 0
fi

# --force skips the interactive confirmation, which would fail in CI.
node "$CF" workers delete "$WORKER_NAME" --force > /dev/null
echo "  ok  Deleted Worker: ${WORKER_NAME}"

echo "==> Cleanup complete"
