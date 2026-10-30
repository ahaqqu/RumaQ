#!/usr/bin/env bash
# ============================================================
# scripts/deploy/vps.sh — ship the scraper through the box's shared
# deploy contract
# ============================================================
# Invoked by scripts/deploy.sh (`./scripts/deploy.sh vps`) for commit-based
# deploys from CI and manual operator runs. Four stages, first failure aborts:
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
#   4. doctor   run the shared box sweep (`bash /srv/vps-ops/doctor.sh`) as
#               rumaq-deploy after the swap; a missing or failing sweep fails
#               the deploy, so a green deploy cannot hide a broken nginx config,
#               a failed unit or a filling disk
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

# Sourced by scripts/test/vps-deploy.sh for run_doctor/ship. Sourcing must leave
# the caller's shell options and variables alone: no top-level `set`, no
# top-level assignments (the caps in artifact.sh are the only exception). The
# direct-execution branch at the bottom starts the real run.
usage() {
  # The header is every leading comment line after the shebang; deriving it
  # keeps --help from printing code or cutting the block when lines move.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

log() { printf 'deploy/vps: %s\n' "$*"; }
die() { printf 'deploy/vps: %s\n' "$*" >&2; exit 1; }

cleanup() {
  [ -z "${WORKDIR:-}" ] || rm -rf "$WORKDIR"
}

# shellcheck source=scripts/deploy/artifact.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/artifact.sh"

# The deploy identity's only SSH options: never prompt, and accept a first-use
# host key (CI has no known_hosts entry). Both stages use the same options.
ssh_deploy() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$@"
}

# run_doctor — the shared box sweep every deploy ends with (ahaqqu/vps
# ops/doctor.sh). Read-only, unprivileged, and the reason the grant carries
# `nginx -t` / `certbot certificates`. It runs after vps-deploy returns, so it
# checks the post-swap box. A missing or failing sweep fails the deploy: a green
# deploy on a broken box is not a deploy.
run_doctor() {
  local target="$1" status=0
  log "running the shared box sweep: bash /srv/vps-ops/doctor.sh"
  ssh_deploy "$target" 'bash /srv/vps-ops/doctor.sh' || status=$?
  case "$status" in
    0) return 0 ;;
    127)
      die "the shared doctor gate is missing on ${target} (/srv/vps-ops/doctor.sh) — install it with the ahaqqu/vps applier, then redeploy"
      ;;
    *)
      die "the shared doctor gate failed on ${target} (exit ${status}) — fix the box before redeploying; this deploy is not done"
      ;;
  esac
}

build_artifact() {
  local root_dir="$1" stage="$2" artifact="$3"
  local scraper_dir="$root_dir/scraper"
  command -v bun >/dev/null 2>&1 || die "bun is required to build the scraper"
  log "building the scraper bundle (playwright-core external)"
  bun install --frozen-lockfile --cwd "$root_dir"
  mkdir -p "$stage/dist" "$stage/node_modules"
  bun build "$scraper_dir/src/main.ts" \
    --target=bun \
    --external playwright-core \
    --outfile "$stage/dist/index.js"
  # The Scrape Now agent ships beside the CLI — same tree, same node_modules;
  # it imports no playwright, nothing to mark external.
  bun build "$scraper_dir/src/agent.ts" \
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
  [ -d "$scraper_dir/node_modules/playwright-core" ] ||
    die "scraper/node_modules/playwright-core is missing — run bun install"
  cp -L -r "$scraper_dir/node_modules/playwright-core" "$stage/node_modules/playwright-core"
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
  local artifact="$1" app="${2:-rumaq}"
  local user host target remote_artifact
  [ -n "${RUMAQ_VPS_HOST:-}" ] ||
    die "RUMAQ_VPS_HOST is required — the box (or an ssh alias) to deploy to"
  command -v rsync >/dev/null 2>&1 || die "rsync is required to upload the artifact"
  command -v ssh >/dev/null 2>&1 || die "ssh is required to reach the box"
  user="${RUMAQ_VPS_USER:-rumaq-deploy}"
  host="$RUMAQ_VPS_HOST"
  target="${user}@${host}"
  remote_artifact="/srv/vps-incoming/${app}.tar.gz"

  log "uploading $(basename "$artifact") to ${target}:${remote_artifact}"
  rsync -a --partial -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
    "$artifact" "${target}:${remote_artifact}"
  log "deploying $app through vps-deploy (swap, agent restart, self-check health)"
  ssh_deploy "$target" "sudo -n /usr/local/sbin/vps-deploy $app"
  run_doctor "$target"
  log "done. deployed, self-check-verified, doctor-clean."
}

main() {
  set -euo pipefail
  local arg dry_run=0 root_dir stage artifact
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry_run=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $arg (usage: $0 [--dry-run])"
        ;;
    esac
  done

  root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/rumaq-vps-deploy-XXXXXX")"
  trap cleanup EXIT
  stage="$WORKDIR/stage"
  artifact="$WORKDIR/rumaq.tar.gz"
  mkdir -p "$stage"

  build_artifact "$root_dir" "$stage" "$artifact"

  if [ "$dry_run" -eq 1 ]; then
    log "dry run: built $artifact ($(stat -c '%s' "$artifact") bytes, $(tar -tzf "$artifact" | wc -l) entries)"
    log "dry run: would upload to ${RUMAQ_VPS_USER:-rumaq-deploy}@<host>:/srv/vps-incoming/rumaq.tar.gz (RUMAQ_VPS_HOST)"
    log "dry run: would run: ssh <host> 'sudo -n /usr/local/sbin/vps-deploy rumaq'"
    log "dry run: would then run: ssh <host> 'bash /srv/vps-ops/doctor.sh'"
    tar -tzf "$artifact" |
      grep -E '^\./(dist/index\.js|dist/agent\.js|node_modules/playwright-core/package\.json)$'
    exit 0
  fi

  ship "$artifact"
}

# Sourced by scripts/test/vps-deploy.sh to drive ship/run_doctor with fake
# ssh/rsync shims; executed normally otherwise.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
