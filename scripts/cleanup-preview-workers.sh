#!/usr/bin/env bash
set -euo pipefail

# Delete all branch-preview Workers (rumaq-api-*). Production Worker `api`,
# the shared preview D1 database, and unrelated Workers are never touched.
# Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID via the environment
# or .env at the project root.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="rumaq-api-"
CF="$ROOT_DIR/node_modules/cf/bin/cf"

# Load .env from project root (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, etc.)
if [[ -f $ROOT_DIR/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

echo "==> Listing Workers"
workers_json=$(node "$CF" workers list)

targets=$(
  printf '%s' "$workers_json" | node -e '
    let d = "";
    process.stdin.on("data", c => (d += c)).on("end", () => {
      const prefix = process.argv[1];
      for (const w of JSON.parse(d)) {
        if (w.name.startsWith(prefix)) console.log(w.name);
      }
    });
  ' "$PREFIX"
)

if [[ -z $targets ]]; then
  echo "  -   No ${PREFIX}* Workers found"
  exit 0
fi

echo "==> Deleting preview Workers (prefix ${PREFIX}):"
deleted=0
while IFS= read -r name; do
  [[ -z $name ]] && continue
  # --force skips the interactive confirmation, which would fail in scripts.
  node "$CF" workers delete "$name" --force > /dev/null
  echo "  ok  Deleted ${name}"
  deleted=$((deleted + 1))
done <<< "$targets"

echo "==> Purge complete: deleted ${deleted} preview Worker(s)"
