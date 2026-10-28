#!/usr/bin/env bash
# Enable the Tier-3 per-store proxy for Lotte on the VPS (docs/ARCHITECTURE.md
# § Price data pipeline): point LOTTE_PROXY_URL at the home-box reverse tunnel
# and restart the nightly unit.
#
#   ./scripts/ops/enable-lotte-proxy.sh
#
# SSH target: the `rumaq-vps` ssh-config alias (set RUMAQ_VPS_TARGET to
# override) — the address itself lives in ~/.ssh/config, not in this repo:
#
#   Host rumaq-vps
#       HostName <your-vps-address>
#       User ahaqqu
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
# The env edit needs root on the box (the env file is root:root 0600). sudo
# cannot prompt through piped stdin — ssh refuses PTY allocation when stdin is
# not a terminal, and with a forced PTY the piped script lines would be eaten
# as sudo password attempts — so the edit is staged as a temp file on the VPS
# and run through an interactive `ssh -t` with the terminal as stdin.
set -euo pipefail

SSH_TARGET="${RUMAQ_VPS_TARGET:-rumaq-vps}"
PROXY_URL="http://127.0.0.1:18080"
REMOTE_TMP="/tmp/rumaq-lotte-proxy-enable.sh"

log() { printf 'enable-lotte-proxy: %s\n' "$*"; }

log "checking the tunnel egress from the VPS (${SSH_TARGET})…"
EGRESS_IP="$(ssh -o BatchMode=yes "${SSH_TARGET}" \
  "curl -s --max-time 20 -x ${PROXY_URL} https://ipinfo.io/json" \
  | jq -r '.ip // empty' || true)"
if [ -z "${EGRESS_IP}" ]; then
  log "FAIL: no response through ${PROXY_URL} — is the tunnel down?"
  log "  On the home box: systemctl --user status lotte-tunnel lotte-connect-proxy"
  exit 1
fi
VPS_IP="$(ssh -o BatchMode=yes "${SSH_TARGET}" \
  "curl -s --max-time 20 https://ipinfo.io/json" \
  | jq -r '.ip // empty' || true)"
if [ "${EGRESS_IP}" = "${VPS_IP}" ]; then
  log "FAIL: proxied egress equals the VPS IP (${VPS_IP}) — the tunnel is looping, not forwarding."
  exit 1
fi
log "OK: proxied egress is ${EGRESS_IP} (VPS direct: ${VPS_IP})"

log "staging the env edit on the box, then asking for sudo…"
STAGE_FILE="$(mktemp)"
cleanup() {
  rm -f "${STAGE_FILE}"
  ssh -o BatchMode=yes "${SSH_TARGET}" "rm -f ${REMOTE_TMP}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cat > "${STAGE_FILE}" <<'REMOTE'
grep -q "^LOTTE_PROXY_URL=" /etc/rumaq-scraper/env ||
  printf '\n# Tier-3 per-store proxy for Lotte (home-box reverse tunnel)\nLOTTE_PROXY_URL=http://127.0.0.1:18080\n' \
    >> /etc/rumaq-scraper/env
systemctl restart rumaq-scraper
systemctl is-active rumaq-scraper
grep -n "^LOTTE_PROXY_URL=" /etc/rumaq-scraper/env
REMOTE
ssh -o BatchMode=yes "${SSH_TARGET}" "cat > ${REMOTE_TMP}" < "${STAGE_FILE}"
ssh -t "${SSH_TARGET}" "sudo sh ${REMOTE_TMP}"

log "done. The next nightly run (23:00 UTC) scrapes Lotte through the home IP."
log "Rollback: remove the LOTTE_PROXY_URL line from /etc/rumaq-scraper/env and"
log "restart the unit — the pipeline then reports the needs-proxy skip again."
