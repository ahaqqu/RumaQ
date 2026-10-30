#!/usr/bin/env bash
# scripts/deploy/artifact.sh — the scraper artifact verifier and the deploy
# contract's size caps.
#
# Sourced by scripts/deploy/vps.sh before the upload and by
# scripts/test/vps-deploy.sh, which drives verify_artifact() with handcrafted
# archives. This file is never executed: it sets no shell options and makes no
# assignments beyond the two caps, so sourcing it leaves the caller's shell
# alone.
#
# MAX_COMPRESSED_BYTES / MAX_UNPACKED_BYTES are rumaq/deploy.conf's max_bytes /
# max_unpacked_bytes in ahaqqu/vps. vps-deploy re-checks both as root before it
# extracts a byte; proving them here keeps an oversized build from being
# uploaded first. scripts/test/vps-deploy.sh pins the pair to the contract
# values.
MAX_COMPRESSED_BYTES=536870912
MAX_UNPACKED_BYTES=1073741824

artifact_die() {
  printf 'deploy/artifact: %s\n' "$*" >&2
  exit 1
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
  [ -s "$artifact" ] || artifact_die "artifact $artifact is empty"

  size="$(stat -c '%s' "$artifact")"
  [ "$size" -le "$MAX_COMPRESSED_BYTES" ] ||
    artifact_die "artifact is $size bytes, over the ${MAX_COMPRESSED_BYTES}-byte contract cap"

  listing="$(tar -tzf "$artifact")" || artifact_die "artifact $artifact is not a readable tar.gz"
  [ -n "$listing" ] || artifact_die "artifact $artifact has no entries"

  for name in ./dist/index.js ./dist/agent.js ./node_modules/playwright-core/package.json; do
    grep -qxF "$name" <<< "$listing" || artifact_die "artifact is missing $name"
  done

  if grep -qE '^\./browsers(/|$)' <<< "$listing"; then
    artifact_die "artifact contains browsers/ — the Chromium cache is preserved state, not code"
  fi

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      /*) artifact_die "artifact entry is absolute: $name" ;;
    esac
    rel="${name#./}"
    case "/${rel}/" in
      *"/../"*) artifact_die "artifact entry traverses upward: $name" ;;
    esac
  done <<< "$listing"

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      [-d]*) ;;
      *) artifact_die "artifact contains a non-regular entry (only files and directories are allowed): $line" ;;
    esac
    # GNU tar -tv: <type+mode> <owner>/<group> <size> <date> <time> <name>.
    size="$(printf '%s\n' "$line" | awk '{print $3}')"
    case "$size" in
      '' | *[!0-9]*) artifact_die "artifact listing has no readable size: $line" ;;
    esac
    total=$((total + size))
    [ "$total" -le "$MAX_UNPACKED_BYTES" ] ||
      artifact_die "artifact unpacks to more than ${MAX_UNPACKED_BYTES} bytes; refusing to ship it"
  done <<< "$(tar -tvzf "$artifact")"
}
