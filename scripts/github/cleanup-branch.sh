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

echo "==> Cleaning up branch: ${BRANCH_NAME}"
echo "    Worker: ${WORKER_NAME}"

# Delete the branch-specific Worker. Worker name/bindings live in
# backend/cloudflare.config.ts; pass the name explicitly for deletion.
if node "$ROOT_DIR/node_modules/cf/bin/cf" workers delete "$WORKER_NAME" 2> /dev/null; then
  echo "  ok  Deleted Worker: ${WORKER_NAME}"
else
  echo "  -   Worker ${WORKER_NAME} not found or already deleted"
fi

# Cloudflare Pages preview branches are not deleted here because the
# Pages project retains preview deployments per branch; removing the branch
# Worker is sufficient to make the preview frontend non-functional.
# If preview storage becomes a concern, add pages deployment deletion later.

echo "==> Cleanup complete"
