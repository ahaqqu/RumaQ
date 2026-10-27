#!/usr/bin/env bash
# Enable the Tier-3 per-store proxy for Lotte on the VPS (docs/ARCHITECTURE.md
# § Price data pipeline): point LOTTE_PROXY_URL at the home-box reverse tunnel
# and restart the nightly unit.
#
#   ./scripts/ops/enable-lotte-proxy.sh
#
# Prerequisites:
#   - The home-box tunnel services are running (user units
#     lotte-connect-proxy.service + lotte-tunnel.service, installed 2026-10-28;
#     they keep the VPS's 127.0.0.1:18080 forwarded to the home proxy, whose
#     egress is the home residential IP the browser tier passes Incapsula
#     from).
#   - Lotte's site is out of maintenance. While lottemart.co.id serves its
#     "Scheduled Maintenance" page and 404s /all-promo-mart, the nightly run
#     fails with a real HTTP 404 (red) — the proxy cannot fix a dead origin.
#     Verify from a real browser first; a plain curl only ever sees the
#     Incapsula challenge, not the origin state.
#
# The env edit needs root on the box (the env file is root:root 0600), so the
# script asks for the sudo password once over an interactive ssh.
set -euo pipefail

SSH_TARGET="${RUMAQ_VPS_USER:-ahaqqu}@${RUMAQ_VPS_HOST:-62.83.35.220}"
PROXY_URL="http://127.0.0.1:18080"

log() { printf 'enable-lotte-proxy: %s\n' "$*"; }

log "checking the tunnel egress from the VPS (${SSH_TARGET})…"
EGRESS_IP="$(ssh -o BatchMode=yes "${SSH_TARGET}" \
  "curl -s --max-time 20 -x ${PROXY_URL} https://ipinfo.io/json" \
  | python3 -c 'import json, sys; print(json.load(sys.stdin).get("ip", ""))' || true)"
if [ -z "${EGRESS_IP}" ]; then
  log "FAIL: no response through ${PROXY_URL} — is the tunnel down?"
  log "  On the home box: systemctl --user status lotte-tunnel lotte-connect-proxy"
  exit 1
fi
VPS_IP="$(ssh -o BatchMode=yes "${SSH_TARGET}" \
  "curl -s --max-time 20 https://ipinfo.io/json" \
  | python3 -c 'import json, sys; print(json.load(sys.stdin).get("ip", ""))' || true)"
if [ "${EGRESS_IP}" = "${VPS_IP}" ]; then
  log "FAIL: proxied egress equals the VPS IP (${VPS_IP}) — the tunnel is looping, not forwarding."
  exit 1
fi
log "OK: proxied egress is ${EGRESS_IP} (VPS direct: ${VPS_IP})"

log "asking for sudo on the box to set LOTTE_PROXY_URL and restart the unit…"
ssh -t "${SSH_TARGET}" 'sudo sh -s' <<'REMOTE'
grep -q "^LOTTE_PROXY_URL=" /etc/rumaq-scraper/env ||
  printf '\n# Tier-3 per-store proxy for Lotte (home-box reverse tunnel)\nLOTTE_PROXY_URL=http://127.0.0.1:18080\n' \
    >> /etc/rumaq-scraper/env
systemctl restart rumaq-scraper
systemctl is-active rumaq-scraper
grep -n "^LOTTE_PROXY_URL=" /etc/rumaq-scraper/env
REMOTE

log "done. The next nightly run (23:00 UTC) scrapes Lotte through the home IP."
log "Rollback: remove the LOTTE_PROXY_URL line from /etc/rumaq-scraper/env and"
log "restart the unit — the pipeline then reports the needs-proxy skip again."
