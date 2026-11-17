#!/usr/bin/env bash
set -euo pipefail

# Delete branch-preview Workers (rumaq-api-*). Production Worker `api`,
# the shared preview D1 database, and unrelated Workers are never touched.
# Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID via the environment
# or .env at the project root.
#
# Safety (audit S6): a preview Worker belongs to an open PR — the PR workflow
# still expects it, and one stray run must not kill live previews. The sweep
# therefore refuses while open PRs exist (or while they cannot be listed);
# --all deletes every rumaq-api-* Worker regardless.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="rumaq-api-"
CF="$ROOT_DIR/node_modules/cf/bin/cf"

DELETE_ALL=false
case "${1:-}" in
  '') ;;
  --all) DELETE_ALL=true ;;
  *)
    echo "Usage: $0 [--all]" >&2
    exit 2
    ;;
esac

if [ "$DELETE_ALL" = false ]; then
  echo "==> Checking for open PRs whose preview Workers must survive"
  if open_prs=$(gh -R ahaqqu/RumaQ pr list --state open --limit 20 2>/dev/null); then
    if [ -n "$open_prs" ]; then
      echo "==> Refusing: open PRs still expect their preview Workers:"
      printf '%s\n' "$open_prs" | sed 's/^/    /'
      echo "    Re-run with --all to delete every ${PREFIX}* Worker anyway."
      exit 1
    fi
  else
    echo "==> Refusing: cannot list open PRs (is gh installed and authenticated?)"
    echo "    Re-run with --all to delete every ${PREFIX}* Worker anyway."
    exit 1
  fi
fi

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
