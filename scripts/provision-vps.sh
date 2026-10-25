#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# scripts/provision-vps.sh — one-shot operator bootstrap of the
# scraper box (scraper/provision/vps/apply.sh + everything it
# cannot do itself)
# ============================================================
# Run this ONCE from a checkout, locally:
#   ./scripts/provision-vps.sh
#
# Root SSH is disabled on the box (homepage MACHINE.md lockdown),
# so apply.sh — which must run as root — is executed through ONE
# interactive `ssh -t ... sudo` that asks for the admin password
# exactly once. Everything the script does on the way:
#
#   1. preflight  admin + deploy identities reachable, tools present
#   2. build      the same bundle + playwright-core copy the real
#                 deploy ships (scripts/deploy/vps.sh stage 1), so
#                 apply.sh --install-deps finds a tree to work with
#   3. secrets    /etc/rumaq-scraper/env is filled from
#                 ~/.config/rumaq/ingest-secret (this machine only)
#                 + the Gemini API key (prompted, read -s, or
#                 --gemini-key-file / $GEMINI_API_KEY)
#   4. root run   apply.sh (users/units/sudoers/env) → env fill →
#                 tree ship (--chown deploy) → --install-deps →
#                 chromium (as deploy user) → selfcheck → cleanup
#
# Idempotent: safe to re-run (apply.sh reconciles, env re-filled,
# rsync merges, chromium install no-ops when the revision matches).
#
# The nightly timer is deliberately NOT enabled here — go-live
# (apply.sh --enable-timer + RUMAQ_PUBLISH=true) is a separate,
# deliberate step.
#
# No secret is ever echoed or written into the repo. The staged
# env-values file travels 0600 and is deleted on the box by the
# root run.
# ============================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRAPER_DIR="$ROOT_DIR/scraper"

HOST="kajianq.ahaqqu.com"
ADMIN_USER="ahaqqu"
ADMIN_HOME="/home/ahaqqu"
DEPLOY_USER="kajianq-deploy"
REMOTE_STAGE="rumaq-provision" # under the admin user's home
DEPLOY_ROOT="/srv/rumaq-scraper"
BROWSERS_PATH="$DEPLOY_ROOT/browsers"
INGEST_URL="https://api.rumaq.workers.dev/api/internal/ingest/prices"
# Generated once during provisioning prep; the same value is the
# GitHub secret HAQITA_INGEST_SECRET (the Worker side of the pair).
INGEST_SECRET_FILE="$HOME/.config/rumaq/ingest-secret"

ADMIN_SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)
DEPLOY_KEY=""
for candidate in "$HOME/.ssh/rumaq-vps-deploy" "$HOME/.ssh/kajianq-deploy"; do
  if [ -f "$candidate" ]; then DEPLOY_KEY="$candidate"; break; fi
done
DEPLOY_SSH=(ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10)

GEMINI_KEY_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --gemini-key-file) GEMINI_KEY_FILE="${2:?--gemini-key-file needs a path}"; shift 2 ;;
    *) echo "provision-vps: unknown argument: $1" >&2; echo "usage: $0 [--gemini-key-file FILE]" >&2; exit 1 ;;
  esac
done

log() { printf 'provision-vps: %s\n' "$*"; }
die() { printf 'provision-vps: %s\n' "$*" >&2; exit 1; }

# --- 1. preflight -------------------------------------------------------------
log "preflight: local tools"
command -v bun >/dev/null || die "bun not found on PATH"
command -v openssl >/dev/null || die "openssl not found on PATH"
command -v rsync >/dev/null || die "rsync not found on PATH"
[ -f "$INGEST_SECRET_FILE" ] || die "missing $INGEST_SECRET_FILE (the ingest secret shared with the Worker)"

log "preflight: ssh identities"
"${ADMIN_SSH[@]}" "$ADMIN_USER@$HOST" true || die "cannot ssh $ADMIN_USER@$HOST (passwordless key required)"
[ -n "$DEPLOY_KEY" ] || die "no deploy key (~/.ssh/rumaq-vps-deploy or ~/.ssh/kajianq-deploy)"
"${DEPLOY_SSH[@]}" "$DEPLOY_USER@$HOST" true || die "cannot ssh $DEPLOY_USER@$HOST with $DEPLOY_KEY"
"${ADMIN_SSH[@]}" "$ADMIN_USER@$HOST" 'test -x /usr/bin/bun' || die "/usr/bin/bun missing on the box"

# --- 2. the Gemini key --------------------------------------------------------
# Discovery order: --gemini-key-file > $GEMINI_API_KEY > the sibling KajianQ
# checkout's .env — but ONLY when that value is a genuine AI Studio key
# (`AIza…`; other Google credential formats live in .env files and must not
# be reused here silently) > interactive prompt with retries. The value is
# never echoed anywhere.
KAJIANQ_ENV="$HOME/Projects/KajianQ/.env"
GEMINI_API_KEY=""
if [ -n "$GEMINI_KEY_FILE" ]; then
  GEMINI_API_KEY="$(tr -d '[:space:]' < "$GEMINI_KEY_FILE")"
elif [ -n "${GEMINI_API_KEY:-}" ]; then
  GEMINI_API_KEY="${GEMINI_API_KEY// /}"
elif [ -f "$KAJIANQ_ENV" ] && grep -q '^GEMINI_API_KEY=AIza' "$KAJIANQ_ENV"; then
  GEMINI_API_KEY="$(sed -n 's/^GEMINI_API_KEY=//p' "$KAJIANQ_ENV" | head -1 | tr -d '[:space:]')"
  log "Gemini key: found in $KAJIANQ_ENV"
else
  [ -f "$KAJIANQ_ENV" ] && grep -q '^GEMINI_API_KEY=..' "$KAJIANQ_ENV" \
    && log "Gemini key: $KAJIANQ_ENV has one, but it is not an AI Studio key (AIza…) — ignoring it"
  for attempt in 1 2 3; do
    printf 'Gemini API key (https://aistudio.google.com/apikey), input hidden: '
    IFS= read -rs GEMINI_API_KEY </dev/tty
    printf '\n'
    [[ $GEMINI_API_KEY =~ ^[A-Za-z0-9._-]+$ ]] && break
    GEMINI_API_KEY=""
    echo "provision-vps: key was empty or has unexpected characters (attempt $attempt of 3)" >&2
  done
fi
# The env file is sourced by the units and re-read by the root
# run's sed — keep every value inside a boring charset and fail
# fast here rather than mysteriously on the box.
[[ $GEMINI_API_KEY =~ ^[A-Za-z0-9._-]+$ ]] || die "no usable Gemini key — re-run with --gemini-key-file FILE, export GEMINI_API_KEY, or paste one at the prompt (https://aistudio.google.com/apikey)"
INGEST_SECRET="$(tr -d '[:space:]' < "$INGEST_SECRET_FILE")"
[[ $INGEST_SECRET =~ ^[A-Za-z0-9_-]+$ ]] || die "ingest secret in $INGEST_SECRET_FILE has unexpected characters"

# --- 3. build the tree the root run ships --------------------------------------
# Same commands as scripts/deploy/vps.sh stage 1 (kept in sync
# manually): bundle + the playwright-core dir it spawns its driver
# from. Shipping it now is what makes apply.sh --install-deps
# possible in the same root session as the bootstrap.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/rumaq-provision-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

log "building the scraper bundle (playwright-core external)"
bun install --frozen-lockfile --cwd "$ROOT_DIR"
bun build "$SCRAPER_DIR/src/main.ts" \
  --target=bun \
  --external playwright-core \
  --outfile "$STAGE/stage/dist/index.js"
[ -s "$STAGE/stage/dist/index.js" ] || die "bundle is empty — the build produced nothing"
mkdir -p "$STAGE/stage/node_modules"
cp -L -r "$SCRAPER_DIR/node_modules/playwright-core" "$STAGE/stage/node_modules/playwright-core"

log "staging provision tree + env values"
mkdir -p "$STAGE/provision"
cp -r "$SCRAPER_DIR/provision/vps/." "$STAGE/provision/"
# 0600: the admin identity owns the staging dir, but the values
# must not be readable by anything else on the box while staged.
(
  umask 077
  {
    printf 'GEMINI_API_KEY=%s\n' "$GEMINI_API_KEY"
    printf 'RUMAQ_INGEST_URL=%s\n' "$INGEST_URL"
    printf 'RUMAQ_INGEST_SECRET=%s\n' "$INGEST_SECRET"
  } > "$STAGE/env-values"
)

# The entire privileged half, in one file, for ONE sudo password.
# Written with @PLACEHOLDER@s (quoted heredoc — nothing expands
# locally) then substituted with the constants above; every value
# is [a-z0-9/._-] by construction, so sed is safe here.
cat > "$STAGE/root-run.sh" <<'ROOT_RUN'
#!/usr/bin/env bash
set -euo pipefail
STAGE_HOME='@ADMIN_HOME@/@REMOTE_STAGE@'

echo "root-run: 1/6 apply.sh (users, dirs, units, sudoers, env skeleton)"
bash "$STAGE_HOME/provision/apply.sh"

echo "root-run: 2/6 filling /etc/rumaq-scraper/env"
set -a; . "$STAGE_HOME/env-values"; set +a
sed -i \
  -e "s|^GEMINI_API_KEY=.*|GEMINI_API_KEY=$GEMINI_API_KEY|" \
  -e "s|^RUMAQ_INGEST_URL=.*|RUMAQ_INGEST_URL=$RUMAQ_INGEST_URL|" \
  -e "s|^RUMAQ_INGEST_SECRET=.*|RUMAQ_INGEST_SECRET=$RUMAQ_INGEST_SECRET|" \
  /etc/rumaq-scraper/env
chmod 0600 /etc/rumaq-scraper/env

echo "root-run: 3/6 shipping the pre-built tree (deploy-owned)"
rsync -a --chown=@DEPLOY_USER@:@DEPLOY_USER@ "$STAGE_HOME/stage/" '@DEPLOY_ROOT@/'

echo "root-run: 4/6 chromium system libraries (apt, from shipped playwright-core)"
bash "$STAGE_HOME/provision/apply.sh" --install-deps

echo "root-run: 5/6 chromium binary (as @DEPLOY_USER@, deploy-owned browsers dir)"
sudo -u @DEPLOY_USER@ env PLAYWRIGHT_BROWSERS_PATH='@BROWSERS_PATH@' \
  /usr/bin/bun '@DEPLOY_ROOT@/node_modules/playwright-core/cli.js' install chromium

echo "root-run: 6/6 self-check with the real env (the deploy gate)"
systemctl start rumaq-scraper-selfcheck.service
if systemctl is-failed --quiet rumaq-scraper-selfcheck.service; then
  echo "root-run: SELF-CHECK FAILED — last 30 journal lines:" >&2
  journalctl -u rumaq-scraper-selfcheck.service -n 30 --no-pager >&2 || true
  rm -rf "$STAGE_HOME"
  exit 1
fi

rm -rf "$STAGE_HOME"
echo "root-run: PROVISION OK — timer left disabled (go-live: apply.sh --enable-timer + RUMAQ_PUBLISH)"
ROOT_RUN
for pair in \
  "@ADMIN_HOME@|$ADMIN_HOME" \
  "@REMOTE_STAGE@|$REMOTE_STAGE" \
  "@DEPLOY_USER@|$DEPLOY_USER" \
  "@DEPLOY_ROOT@|$DEPLOY_ROOT" \
  "@BROWSERS_PATH@|$BROWSERS_PATH"; do
  value="${pair#*|}"
  [[ $value =~ ^[A-Za-z0-9/._-]+$ ]] || die "internal: unsafe substitution value for ${pair%%|*}"
  sed -i "s|${pair%%|*}|$value|g" "$STAGE/root-run.sh"
done

log "staging everything to $ADMIN_USER@$HOST:~/$REMOTE_STAGE"
rsync -az -e ssh "$STAGE/" "$ADMIN_USER@$HOST:$REMOTE_STAGE/"

# --- 4. the one privileged run -------------------------------------------------
log "running the privileged half on the box (sudo password prompted once)"
ssh -t "$ADMIN_USER@$HOST" "sudo bash '$ADMIN_HOME/$REMOTE_STAGE/root-run.sh'"

# --- 5. unprivileged verification ----------------------------------------------
log "verifying from the deploy identity"
"${DEPLOY_SSH[@]}" "$DEPLOY_USER@$HOST" "
  test -d $DEPLOY_ROOT/dist && echo 'tree: present' || echo 'tree: MISSING'
  test -d $BROWSERS_PATH && echo 'browsers: present' || echo 'browsers: MISSING'
  systemctl is-enabled rumaq-scraper.timer 2>/dev/null || true
"
log "done. The nightly timer is intentionally NOT enabled — go-live is"
log "apply.sh --enable-timer + RUMAQ_PUBLISH=true (planned milestone 4)."
log "Next: the commit-based deploy can now run (deploy.yml deploy-vps job)."
