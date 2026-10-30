#!/usr/bin/env bash
# ============================================================
# scripts/deploy/browser-revision.sh — install the Chromium revision an
# uploaded scraper artifact expects into the box's preserved cache
# ============================================================
# Run after scripts/deploy/vps.sh has uploaded an artifact whose
# node_modules/playwright-core wants a new revision (a playwright-core bump).
# vps-deploy's self-check cannot launch Chromium, fails, and rolls the deploy
# back; this script installs the revision from the uploaded artifact as
# rumaq-deploy and heals the modes, then the deploy can be re-run.
#
# It runs over SSH as rumaq-deploy — the identity that owns browsers/ — and does
# on the box:
#   1. extract /srv/vps-incoming/rumaq.tar.gz into a temp dir
#   2. install that tree's chromium revision with
#      PLAYWRIGHT_BROWSERS_PATH=<root>/browsers
#   3. chmod 755 <root>/browsers && chmod -R go+rX <root>/browsers
# Chromium's installer manages its own directories and may tighten them to 0700.
# The service user (rumaq-scraper) is not the deploy identity, so without step 3
# the next self-check cannot read the revision and the deploy rolls back again.
#
# Then re-run ./scripts/deploy.sh vps.
#
# Configuration:
#   RUMAQ_VPS_HOST  required — the box (or an ~/.ssh/config alias)
#   RUMAQ_VPS_USER  default rumaq-deploy — the only identity that may write browsers/
#   RUMAQ_VPS_ROOT  default /srv/rumaq-scraper — must match rumaq/deploy.conf
# ============================================================

usage() {
  # The header is every leading comment line after the shebang; deriving it
  # keeps --help from printing code or cutting the block when lines move.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

log() { printf 'deploy/browser-revision: %s\n' "$*"; }
die() { printf 'deploy/browser-revision: %s\n' "$*" >&2; exit 1; }

main() {
  set -euo pipefail
  local root user host target remote_script
  case "${1:-}" in
    -h | --help)
      usage
      exit 0
      ;;
    "") ;;
    *)
      die "unknown argument: $1 (usage: $0)"
      ;;
  esac

  [ -n "${RUMAQ_VPS_HOST:-}" ] ||
    die "RUMAQ_VPS_HOST is required — the box (or an ssh alias) to install into"
  command -v ssh >/dev/null 2>&1 || die "ssh is required to reach the box"
  root="${RUMAQ_VPS_ROOT:-/srv/rumaq-scraper}"
  if [[ ! $root =~ ^/[A-Za-z0-9/._-]+$ ]]; then
    die "RUMAQ_VPS_ROOT must be an absolute path matching [A-Za-z0-9/._-] only (got: '$root')"
  fi
  user="${RUMAQ_VPS_USER:-rumaq-deploy}"
  host="$RUMAQ_VPS_HOST"
  target="${user}@${host}"

  # The deployed tree is not in place (the failed deploy rolled it back), so
  # install from the artifact vps-deploy accepted at /srv/vps-incoming/.
  remote_script="$(cat <<'REMOTE'
set -euo pipefail
root="$1"
artifact="$2"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$artifact" -C "$tmp"
PLAYWRIGHT_BROWSERS_PATH="$root/browsers" /usr/bin/bun "$tmp/node_modules/playwright-core/cli.js" install chromium
chmod 755 "$root/browsers"
chmod -R go+rX "$root/browsers"
REMOTE
)"

  log "installing the uploaded artifact's chromium revision as ${target}"
  log "browsers path: ${root}/browsers (chmod 755 + go+rX after install)"
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$target" \
    "bash -s -- '$root' '/srv/vps-incoming/rumaq.tar.gz'" <<<"$remote_script"
  log "done. re-run ./scripts/deploy.sh vps."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
