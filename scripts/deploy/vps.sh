#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# scripts/deploy/vps.sh — ship the scraper through the box's shared
# deploy contract
# ============================================================
# Invoked by scripts/deploy.sh (`./scripts/deploy.sh vps`) for commit-based
# deploys from CI and manual operator runs. Three stages, first failure aborts:
#
#   1. build    self-contained Bun bundles with playwright-core external — it
#               spawns its driver from its own package dir, so the real
#               package ships beside the bundles instead of inside them:
#               dist/index.js (the scraper CLI) and dist/agent.js (the
#               Scrape Now agent), plus node_modules/playwright-core
#   2. package  tar the stage's CONTENTS at the archive root and verify the
#               archive locally: required entries, regular files/directories
#               only, no browsers/, within the contract's size caps
#   3. ship     upload to /srv/vps-incoming/rumaq.tar.gz as rumaq-deploy, then
#               run `sudo -n /usr/local/sbin/vps-deploy rumaq`. The helper
#               verifies the artifact, swaps the tree, carries browsers/
#               (Chromium revision state) across the swap, restarts the Scrape
#               Now agent and health-checks with rumaq-scraper-selfcheck.service
#
# The host side — units, timer, sudoers grant, deploy contract, root-only env
# files — lives in ahaqqu/vps rumaq/ and is installed by that repo's root
# applier. This script writes no unit, env, timer, nginx or sudoers file, and
# never enables or disables the nightly timer (live production, managed there).
#
# Configuration:
#   RUMAQ_VPS_HOST  required to deploy — the box (or an ~/.ssh/config alias)
#   RUMAQ_VPS_USER  default rumaq-deploy — the only identity granted
#                   `vps-deploy rumaq`
#
# No secret flows through this script: the box's env file is root-only and read
# by systemd, never by the deploy.
# ============================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRAPER_DIR="$ROOT_DIR/scraper"

APP="rumaq"
ARTIFACT="rumaq.tar.gz"
REMOTE_ARTIFACT="/srv/vps-incoming/${ARTIFACT}"
RUMAQ_VPS_USER="${RUMAQ_VPS_USER:-rumaq-deploy}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)

# Caps mirror rumaq/deploy.conf in ahaqqu/vps. vps-deploy re-checks both as
# root before it extracts a byte; proving them here keeps an oversized build
# from being uploaded first.
MAX_COMPRESSED_BYTES=536870912
MAX_UNPACKED_BYTES=1073741824

DRY_RUN=0
# Global so the EXIT trap still sees it after main() returns (a function-local
# would be unbound when the trap fires).
WORKDIR=""

log() { printf 'deploy/vps: %s\n' "$*"; }
die() { printf 'deploy/vps: %s\n' "$*" >&2; exit 1; }

cleanup() {
  [ -z "$WORKDIR" ] || rm -rf "$WORKDIR"
}

usage() {
  sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
}

# verify_artifact — the same shape vps-deploy insists on, checked locally so a
# bad build fails before the upload instead of on the box. The failure modes it
# makes visible:
#   - a symlink in the node_modules tree (Bun's .bin links are symlinks) would
#     be refused by the helper's tar table, after the artifact is uploaded;
#   - browsers/ in the artifact would collide with the preserved Chromium cache
#     (the helper's preserve preflight refuses it), and shipping a laptop's
#     revision over the box's cache is never what a code deploy means;
#   - a missing bundle or playwright-core package passes the upload and fails
#     the self-check at 06:00 WIB (or leaves the agent idling on old code);
#   - an oversized archive or entry is refused only after the upload.
verify_artifact() {
  local artifact="$1" listing line name rel size total=0
  [ -s "$artifact" ] || die "artifact $artifact is empty"

  size="$(stat -c '%s' "$artifact")"
  [ "$size" -le "$MAX_COMPRESSED_BYTES" ] ||
    die "artifact is $size bytes, over the ${MAX_COMPRESSED_BYTES}-byte contract cap"

  listing="$(tar -tzf "$artifact")" || die "artifact $artifact is not a readable tar.gz"
  [ -n "$listing" ] || die "artifact $artifact has no entries"

  for name in ./dist/index.js ./dist/agent.js ./node_modules/playwright-core/package.json; do
    grep -qxF "$name" <<<"$listing" || die "artifact is missing $name"
  done

  if grep -qE '^\./browsers(/|$)' <<<"$listing"; then
    die "artifact contains browsers/ — the Chromium cache is preserved state, not code"
  fi

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      /*) die "artifact entry is absolute: $name" ;;
    esac
    rel="${name#./}"
    case "/${rel}/" in
      *"/../"*) die "artifact entry traverses upward: $name" ;;
    esac
  done <<<"$listing"

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      [-d]*) ;;
      *) die "artifact contains a non-regular entry (only files and directories are allowed): $line" ;;
    esac
    # GNU tar -tv: <type+mode> <owner>/<group> <size> <date> <time> <name>.
    size="$(printf '%s\n' "$line" | awk '{print $3}')"
    case "$size" in
      '' | *[!0-9]*) die "artifact listing has no readable size: $line" ;;
    esac
    total=$((total + size))
    [ "$total" -le "$MAX_UNPACKED_BYTES" ] ||
      die "artifact unpacks to more than ${MAX_UNPACKED_BYTES} bytes; refusing to ship it"
  done <<<"$(tar -tvzf "$artifact")"
}

build_artifact() {
  local stage="$1" artifact="$2"
  command -v bun >/dev/null 2>&1 || die "bun is required to build the scraper"
  log "building the scraper bundle (playwright-core external)"
  bun install --frozen-lockfile --cwd "$ROOT_DIR"
  mkdir -p "$stage/dist" "$stage/node_modules"
  bun build "$SCRAPER_DIR/src/main.ts" \
    --target=bun \
    --external playwright-core \
    --outfile "$stage/dist/index.js"
  # The Scrape Now agent ships beside the CLI — same tree, same node_modules;
  # it imports no playwright, nothing to mark external.
  bun build "$SCRAPER_DIR/src/agent.ts" \
    --target=bun \
    --outfile "$stage/dist/agent.js"
  # A deploy that ships an empty stage would pass the upload and fail at 06:00
  # WIB (or leave the agent idling on an old bundle).
  if [ ! -s "$stage/dist/index.js" ] || [ ! -s "$stage/dist/agent.js" ]; then
    die "bundle is empty — the build produced nothing"
  fi
  # playwright-core resolves through the workspace to the .bun store (a
  # symlink) — copy the real directory, not the link. The helper refuses any
  # symlink member, so this dereference is load-bearing, not cosmetic.
  [ -d "$SCRAPER_DIR/node_modules/playwright-core" ] ||
    die "scraper/node_modules/playwright-core is missing — run bun install"
  cp -L -r "$SCRAPER_DIR/node_modules/playwright-core" "$stage/node_modules/playwright-core"
  if [ -n "$(find "$stage" -type l -print -quit)" ]; then
    die "the build produced a symlink; vps-deploy accepts only regular files and directories"
  fi
  tar -czf "$artifact" -C "$stage" .
  # The helper refuses a group/other-writable upload; a developer umask of 002
  # would otherwise turn the artifact into 0664 and fail after the upload.
  chmod 0644 "$artifact"
  verify_artifact "$artifact"
}

ship() {
  local artifact="$1" target
  [ -n "${RUMAQ_VPS_HOST:-}" ] ||
    die "RUMAQ_VPS_HOST is required — the box (or an ssh alias) to deploy to"
  target="${RUMAQ_VPS_USER}@${RUMAQ_VPS_HOST}"
  command -v rsync >/dev/null 2>&1 || die "rsync is required to upload the artifact"
  log "uploading $ARTIFACT to ${target}:${REMOTE_ARTIFACT}"
  rsync -a --partial -e "ssh ${SSH_OPTS[*]}" "$artifact" "${target}:${REMOTE_ARTIFACT}"
  log "deploying $APP through vps-deploy (swap, agent restart, self-check health)"
  ssh "${SSH_OPTS[@]}" "$target" "sudo -n /usr/local/sbin/vps-deploy $APP"
  log "done. deployed and self-check-verified."
}

main() {
  local arg stage artifact
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $arg (usage: $0 [--dry-run])"
        ;;
    esac
  done

  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/rumaq-vps-deploy-XXXXXX")"
  trap cleanup EXIT
  stage="$WORKDIR/stage"
  artifact="$WORKDIR/$ARTIFACT"
  mkdir -p "$stage"

  build_artifact "$stage" "$artifact"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry run: built $artifact ($(stat -c '%s' "$artifact") bytes, $(tar -tzf "$artifact" | wc -l) entries)"
    log "dry run: would upload to ${RUMAQ_VPS_USER}@<host>:${REMOTE_ARTIFACT} (RUMAQ_VPS_HOST)"
    log "dry run: would run: ssh <host> 'sudo -n /usr/local/sbin/vps-deploy $APP'"
    tar -tzf "$artifact" |
      grep -E '^\./(dist/index\.js|dist/agent\.js|node_modules/playwright-core/package\.json)$'
    exit 0
  fi

  ship "$artifact"
}

# Sourced by scripts/test/vps-deploy.sh so the verifier can be driven with
# handcrafted archives; executed normally otherwise.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
