#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# scripts/deploy/vps.sh — ship the scraper to the VPS
# ============================================================
# Invoked by scripts/deploy.sh (`./scripts/deploy.sh vps`) — the repo's
# single deploy entrypoint — for commit-based deploys from CI and manual
# operator runs. Five stages, first failure aborts:
#
#   1. build   one self-contained Bun bundle (playwright-core external —
#              it spawns its driver from its own package dir, so it ships
#              beside the bundle instead of inside it)
#   2. ship    rsync --delete to /srv/rumaq-scraper (the deploy identity
#              owns the tree; browsers/ is preserved — it is revision-
#              locked to the shipped playwright-core, not to the code)
#   3. browsers  install the chromium revision the shipped playwright-core
#              wants into the deploy-owned PLAYWRIGHT_BROWSERS_PATH
#              (idempotent — downloads only when the revision changed)
#   4. selfcheck  sudo systemctl start rumaq-scraper-selfcheck.service
#              (the deploy identity's ONLY root grant): runs the shipped
#              CLI's --self-check as the service user with the real env —
#              a deploy that cannot prove the nightly job runs has not
#              deployed
#   5. doctor  the shared-box sweep from /srv/vps-ops (homepage-owned);
#              unprivileged — without the nginx sudo diagnostics it warns
#
# Configuration (environment; .env is sourced by scripts/deploy.sh):
#   RUMAQ_VPS_HOST   required — the box (or an ~/.ssh/config alias)
#   RUMAQ_VPS_USER   default kajianq-deploy (the box-wide shared deploy
#                    identity — homepage MACHINE.md)
#   RUMAQ_VPS_ROOT   default /srv/rumaq-scraper — must match the units'
#                    paths (provision/vps/apply.sh installs those)
#
# No secrets flow through this script: the env file on the box is root-only
# and is read by systemd, never by the deploy.
# ============================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRAPER_DIR="$ROOT_DIR/scraper"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "deploy/vps.sh: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

log() { printf 'deploy/vps: %s\n' "$*"; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "would: $*"
  else
    "$@"
  fi
}

: "${RUMAQ_VPS_HOST:?RUMAQ_VPS_HOST is required — the box (or an ssh alias) to deploy to}"
RUMAQ_VPS_USER="${RUMAQ_VPS_USER:-kajianq-deploy}"
RUMAQ_VPS_ROOT="${RUMAQ_VPS_ROOT:-/srv/rumaq-scraper}"
# RUMAQ_VPS_ROOT is interpolated inside single-quoted remote command strings
# below — reject any value outside a conservative charset (no quotes,
# spaces, or expansions) so the interpolation can never become injection as
# the deploy identity. Fail fast with a clear message instead of a
# confusing remote error.
if [[ ! $RUMAQ_VPS_ROOT =~ ^/[A-Za-z0-9/._-]+$ ]]; then
  echo "deploy/vps.sh: RUMAQ_VPS_ROOT must be an absolute path matching [A-Za-z0-9/._-] only (got: '${RUMAQ_VPS_ROOT}')" >&2
  exit 1
fi
SSH_TARGET="${RUMAQ_VPS_USER}@${RUMAQ_VPS_HOST}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
BROWSERS_PATH="${RUMAQ_VPS_ROOT}/browsers"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/rumaq-vps-deploy-XXXXXX")"
trap 'rm -rf "${STAGE}"' EXIT

# --- 1. build ---------------------------------------------------------------
# The build runs UNGATED (also in --dry-run): it is local and
# side-effect-free, so `vps --dry-run` is the locally runnable smoke test
# for the ship path — the one part (bundle + playwright-core copy) that can
# fail locally must fail here, not on the box.
log "building the scraper bundle (playwright-core external)"
bun --version >/dev/null
bun install --frozen-lockfile --cwd "$ROOT_DIR"
bun build "$SCRAPER_DIR/src/main.ts" \
  --target=bun \
  --external playwright-core \
  --outfile "$STAGE/dist/index.js"
# The bundle must actually be a bundle: a deploy that ships an empty stage
# would pass rsync and fail at 06:00 WIB.
if [[ ! -s $STAGE/dist/index.js ]]; then
  echo "deploy/vps.sh: bundle is empty — the build produced nothing" >&2
  exit 1
fi
# playwright-core resolves through the workspace to the .bun store (often
# a symlink) — copy the real directory, not the link.
mkdir -p "$STAGE/node_modules"
cp -L -r "$SCRAPER_DIR/node_modules/playwright-core" "$STAGE/node_modules/playwright-core"

# --- 2. ship -----------------------------------------------------------------
log "shipping to ${SSH_TARGET}:${RUMAQ_VPS_ROOT}"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "mkdir -p '${RUMAQ_VPS_ROOT}/dist' '${RUMAQ_VPS_ROOT}/node_modules'"
# --delete with a filter that keeps browsers/ (revision-managed in stage 3,
# not part of the code tree) and the state dir never lives here.
# --chmod=go+rX: the stage is a mktemp dir (0700) and rsync -a would copy
# that onto the tree root — after which the service user (rumaq-scraper)
# can no longer traverse its own code and the self-check dies with
# "Module not found". The service user only ever needs read/traverse.
run rsync -az --delete \
  --chmod=go+rX \
  --filter='protect /browsers/' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/" "${SSH_TARGET}:${RUMAQ_VPS_ROOT}/"

# --- 3. browsers ---------------------------------------------------------------
log "ensuring the chromium revision for the shipped playwright-core"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
  "PLAYWRIGHT_BROWSERS_PATH='${BROWSERS_PATH}' /usr/bin/bun '${RUMAQ_VPS_ROOT}/node_modules/playwright-core/cli.js' install chromium"
# The browser install manages its own directories and may tighten them
# (0700), which locks the service user out of its chromium. Heal the
# modes explicitly — cheap, idempotent, and the nightly job depends on it.
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
  "chmod 755 '${RUMAQ_VPS_ROOT}' '${BROWSERS_PATH}' && chmod -R go+rX '${BROWSERS_PATH}'"

# --- 4. self-check ---------------------------------------------------------------
# The one privileged call in the whole deploy (scoped sudoers grant). For a
# oneshot unit, systemctl start blocks until ExecStart finishes and fails
# with the unit — a red here means the tree on the box cannot run the job.
log "running the post-deploy self-check as the service user"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
  "sudo /usr/bin/systemctl start rumaq-scraper-selfcheck.service"
if [ "$DRY_RUN" -eq 0 ]; then
  if ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "systemctl is-failed --quiet rumaq-scraper-selfcheck.service"; then
    echo "deploy/vps.sh: self-check FAILED — read: journalctl -u rumaq-scraper-selfcheck.service" >&2
    exit 1
  fi
  log "self-check passed"
fi

# --- 5. doctor (shared-box gate) --------------------------------------------------
# One copy on the box, owned by homepage; every app's deploy runs it so a
# change that starves a neighbour turns THIS deploy red (KajianQ §5). Absent
# file is a warning — it appears once homepage has deployed since bootstrap.
log "running the shared-box doctor"
run ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
  'if [ -x /srv/vps-ops/doctor.sh ]; then bash /srv/vps-ops/doctor.sh; else echo "deploy/vps: warning: /srv/vps-ops/doctor.sh not present yet — has homepage deployed since the ops-dir bootstrap?" >&2; fi'

log "done. deployed and self-check-verified."
