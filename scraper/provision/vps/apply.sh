#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# provision/vps/apply.sh — bootstrap rumaq-scraper on the VPS
# ============================================================
# Operator action, run AS ROOT on the box (homepage MACHINE.md runbook:
# "new services follow the per-repo provision/vps/ runbook"). Idempotent —
# re-run after any change to the units or sudoers below.
#
# What it owns (everything else belongs to the deploy or the service user):
#   - system user/group `rumaq-scraper` (no login)
#   - /srv/rumaq-scraper           deploy tree   (owned by kajianq-deploy)
#   - /srv/rumaq-scraper/browsers  chromium      (deploy-managed revision)
#   - /var/lib/rumaq-scraper       state         (owned by rumaq-scraper)
#   - /etc/rumaq-scraper/env       secrets       (root:root 0600, installed
#                                                 once — never overwritten)
#   - three systemd units + one sudoers fragment + the ingest-url repair
#     helper at /usr/local/sbin/rumaq-scraper-ingest-url (root-owned, no
#     arguments, granted to kajianq-deploy in the sudoers fragment)
#
# Usage:
#   ./apply.sh                 # bootstrap / reconcile everything
#   ./apply.sh --install-deps  # + apt deps for the shipped chromium
#                              # (run once after the FIRST deploy; needs the
#                              # tree at /srv/rumaq-scraper)
#   ./apply.sh --enable-timer  # + enable the nightly timer — THE GO-LIVE
#                              # SWITCH (PR4): until this, nothing runs
#                              # nightly and no quota is spent
#
# The deploy identity is the shared `kajianq-deploy` (MACHINE.md); this
# script refuses to run if it does not exist — it never creates deploy
# identities.
# ============================================================

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEPLOY_USER="kajianq-deploy"
SERVICE_USER="rumaq-scraper"
DEPLOY_ROOT="/srv/rumaq-scraper"
STATE_DIR="/var/lib/rumaq-scraper"
ENV_DIR="/etc/rumaq-scraper"
ENV_FILE="${ENV_DIR}/env"

INSTALL_DEPS=0
ENABLE_TIMER=0
for arg in "$@"; do
  case "$arg" in
    --install-deps) INSTALL_DEPS=1 ;;
    --enable-timer) ENABLE_TIMER=1 ;;
    *)
      echo "apply.sh: unknown argument: $arg" >&2
      echo "usage: $0 [--install-deps] [--enable-timer]" >&2
      exit 1
      ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "apply.sh: must run as root (sudo) — it creates users and installs units" >&2
  exit 1
fi

log() { printf 'apply: %s\n' "$*"; }

# --- 1. identities -----------------------------------------------------------
if ! id "$SERVICE_USER" &>/dev/null; then
  log "creating system user $SERVICE_USER (no login)"
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
else
  log "user $SERVICE_USER exists"
fi

if ! id "$DEPLOY_USER" &>/dev/null; then
  echo "apply.sh: deploy identity $DEPLOY_USER does not exist on this box." >&2
  echo "  It is created by the box's bootstrap (homepage MACHINE.md), not by" >&2
  echo "  an app repo. Provision it first, then re-run." >&2
  exit 1
fi

# --- 2. directories ----------------------------------------------------------
install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_ROOT"
install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_ROOT/browsers"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
install -d -m 0750 "$ENV_DIR"
log "directories ready (tree=$DEPLOY_ROOT state=$STATE_DIR)"

# --- 3. env file --------------------------------------------------------------
# Installed once, never overwritten: root edits secrets in place. A mode
# check follows because the units source this file before dropping
# privileges — loose bits would leak keys to every local user.
if [[ ! -f $ENV_FILE ]]; then
  install -m 0600 "$HERE/env.example" "$ENV_FILE"
  log "installed $ENV_FILE from env.example — EDIT IT NOW and fill in the keys"
else
  log "$ENV_FILE exists (left untouched)"
fi
chmod 0600 "$ENV_FILE"

# --- 4. systemd units ---------------------------------------------------------
systemd_dir="/etc/systemd/system"
for unit in rumaq-scraper.service rumaq-scraper.timer rumaq-scraper-selfcheck.service; do
  install -m 0644 "$HERE/systemd/$unit" "$systemd_dir/$unit"
done
systemctl daemon-reload
log "units installed + daemon reloaded"

# --- 4b. the ingest-url repair helper ------------------------------------------
# Root-owned, no arguments, one narrow job (rewrite the env's ingest URL);
# the sudoers fragment below grants it to kajianq-deploy so the repair never
# needs an interactive sudo. The URL is substituted from env.example — the
# repo's single literal for the ingest route — so a route change has one edit.
ingest_url="$(sed -n 's/^RUMAQ_INGEST_URL=//p' "$HERE/env.example")"
[[ $ingest_url =~ ^https://[A-Za-z0-9/._-]+$ ]] || {
  echo "apply.sh: no usable RUMAQ_INGEST_URL in $HERE/env.example" >&2
  exit 1
}
sed "s|@RUMAQ_INGEST_URL@|$ingest_url|" "$HERE/bin/rumaq-scraper-ingest-url" \
  > /usr/local/sbin/rumaq-scraper-ingest-url
chmod 0755 /usr/local/sbin/rumaq-scraper-ingest-url
chown root:root /usr/local/sbin/rumaq-scraper-ingest-url
log "ingest-url repair helper installed at /usr/local/sbin/rumaq-scraper-ingest-url"

# --- 5. sudoers ----------------------------------------------------------------
# Parse gate in front of the install, never after: a malformed sudoers.d
# file can lock sudo out of the box entirely (KajianQ pattern).
if visudo -cf "$HERE/sudoers/rumaq-scraper-deploy" >/dev/null; then
  install -m 0440 -o root -g root "$HERE/sudoers/rumaq-scraper-deploy" /etc/sudoers.d/rumaq-scraper-deploy
  log "sudoers fragment installed (grant: start rumaq-scraper-selfcheck.service)"
else
  echo "apply.sh: sudoers candidate failed visudo -cf — NOT installed" >&2
  exit 1
fi

# --- 6. optional: chromium OS deps ---------------------------------------------
# The browser binary itself ships with each deploy (deploy-owned
# PLAYWRIGHT_BROWSERS_PATH); only its system libraries need apt, once per
# OS, from the shipped playwright-core.
if [[ $INSTALL_DEPS -eq 1 ]]; then
  if [[ -d $DEPLOY_ROOT/node_modules/playwright-core ]]; then
    log "installing chromium system deps (apt) from the shipped playwright-core"
    PLAYWRIGHT_BROWSERS_PATH="$DEPLOY_ROOT/browsers" \
      /usr/bin/bun "$DEPLOY_ROOT/node_modules/playwright-core/cli.js" install-deps chromium
  else
    echo "apply.sh: $DEPLOY_ROOT/node_modules/playwright-core not found." >&2
    echo "  Deploy first (scripts/deploy.sh vps), then re-run with --install-deps." >&2
    exit 1
  fi
fi

# --- 7. timer -------------------------------------------------------------------
# Deliberately NOT enabled by default: enabling is the go-live switch (PR4),
# so the box never spends Gemini quota on dry runs.
if [[ $ENABLE_TIMER -eq 1 ]]; then
  systemctl enable --now rumaq-scraper.timer
  log "timer ENABLED — the nightly scrape (23:00 UTC) is live"
else
  log "timer installed but NOT enabled (go-live: re-run with --enable-timer)"
fi

log "done. Next: deploy the tree (scripts/deploy.sh vps), then"
log "      verify with: sudo systemctl start rumaq-scraper-selfcheck.service"
log "      and read:    journalctl -u rumaq-scraper-selfcheck.service"
