#!/usr/bin/env bash
# Dump the scraper's per-run state off the VPS for diagnosis (read-only):
# run status, rejected items, outbox listing. The state dir is root-group-only
# (rumaq-scraper 750), so the dump sudo-cats the files — expect one sudo
# password prompt over the TTY.
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

ssh -t "$HOST" "sudo -n true 2>/dev/null || echo '--- sudo password required ---'; \
  sudo sh -c '
    echo \"=== status.json ===\"; cat $STATE_DIR/status.json 2>/dev/null || echo missing
    echo; echo \"=== rejected-items.log (last 80) ===\"
    tail -80 $STATE_DIR/rejected-items.log 2>/dev/null || echo empty
    echo; echo \"=== state dir ===\"; ls -la $STATE_DIR
    ${STORE:+echo; echo \"=== $STORE outbox ===\"; ls -la $STATE_DIR/$STORE 2>/dev/null; }
  '"
