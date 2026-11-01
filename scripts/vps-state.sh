#!/usr/bin/env bash
# Dump the scraper's per-run state off the VPS for diagnosis (read-only):
# run status, rejected items, outbox listing. The state dir is group-only
# (rumaq-scraper:rumaq-scraper 750 — vps repo manifest), so the dump
# sudo-cats the files — expect one sudo password prompt over the TTY.
#
# Usage:
#   ./scripts/vps-state.sh                 # rejected-items.log + status.json
#   ./scripts/vps-state.sh hypermart       # + that store's outbox dir listing
#
# Env: RUMAQ_VPS_HOST — the box (or an ~/.ssh/config alias); default rumaq-vps.
set -euo pipefail

HOST="${RUMAQ_VPS_HOST:-rumaq-vps}"
STATE_DIR=/var/lib/rumaq-scraper
STORE="${1:-}"

# The store name rides a root shell on the VPS (the ssh call below), so only
# a bare registry slug may reach it: no metachars, quotes, or path
# separators — the dump stays read-only for any argument, and a typo fails
# here instead of at the root prompt (registry slugs are kebab-case,
# e.g. lotte-mart).
if [[ -n "$STORE" && ! "$STORE" =~ ^[a-z0-9_-]+$ ]]; then
  echo "vps-state.sh: invalid store slug '$STORE' (expected kebab-case, e.g. hypermart)" >&2
  exit 2
fi

# The remote script is a single-quoted literal that reads the state dir and
# store as positional parameters ($1/$2), so no shell expansion is baked
# into the root command beyond the two values above and the body needs no
# escape-layer quoting.
remote='
  echo "=== status.json ==="; cat "$1/status.json" 2>/dev/null || echo missing
  echo; echo "=== rejected-items.log (last 80) ==="
  tail -n 80 "$1/rejected-items.log" 2>/dev/null || echo empty
  echo; echo "=== state dir ==="; ls -la "$1"
  if [ -n "${2:-}" ]; then
    echo; echo "=== $2 outbox ==="; ls -la "$1/$2" 2>/dev/null || echo missing
  fi
'

ssh -t "$HOST" "sudo -n true 2>/dev/null || echo '--- sudo password required ---'; \
  sudo sh -c '$remote' vps-state '$STATE_DIR' '$STORE'"
