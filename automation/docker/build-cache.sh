#!/usr/bin/env bash
# shellcheck shell=bash
# ============================================================
# Content-hash build cache for the toolchain-only automation images (#356)
# ============================================================
# The images carry the toolchain and the installed dependency tree; each
# service builds its own artifact at container start from read-only source
# mounts. That is what makes "source edit => rebuild the image" false, but it
# also puts a ~11 s (api) / ~20 s (web) / ~2 s (bdd) build in front of every run.
# This cache removes that cost for an unedited tree while keeping a wrong
# artifact impossible:
#
#   - the key is a hash of the *content* of every mounted build input (paths are
#     part of the hash, mtimes are not);
#   - the cache volume itself is namespaced by the toolchain digest, so a
#     deps/config edit can never reuse an artifact built from another toolchain;
#   - a missing/unreadable stamp, a failed copy, a disabled cache, or a missing
#     flock all fail open to a real build;
#   - the lock is held for the whole read-copy and copy+swap windows, so a
#     reader can never copy a half-written entry and a writer never publishes a
#     stamp before its artifact.
#
# Kill switch: RUMAQ_BUILD_CACHE=0 (compose forwards it into every service).
# Recovery: ./scripts/test.sh automation-local --clean removes this
# toolchain's cache volume.
# ============================================================

RUMAQ_BUILD_CACHE="${RUMAQ_BUILD_CACHE:-1}"
RUMAQ_CACHE_DIR="${RUMAQ_CACHE_DIR:-/cache}"

# True when caching is both requested and safe. Missing flock is not an error:
# the volume would still be correct but uncoordinated, so builds simply run
# every time (correctness over sharing).
cache_enabled() {
  [[ "$RUMAQ_BUILD_CACHE" != '0' ]] && command -v flock >/dev/null 2>&1
}

# cache_stamp <path>... — 16 hex chars over the content of every file under the
# given paths (files or directories). find's output is sorted so the hash does
# not depend on filesystem order; sha256sum prints the path with each digest, so
# a rename is a change too.
cache_stamp() {
  local link
  # Only regular files are hashed, so a symlinked input would be invisible: a
  # target edit could reuse a stale artifact. Fail closed instead (#356 review
  # B8): a unique stamp never matches a stored one, so the caller builds and
  # overwrites the slot. The repo has no symlinks today; this keeps that
  # assumption enforced rather than assumed.
  link="$(find "$@" -type l -print -quit 2> /dev/null || true)"
  if [[ -n "$link" ]]; then
    printf 'uncacheable-%s-%s\n' "$$" "$RANDOM"
    printf 'build-cache: symlinked input %s makes the artifact uncacheable; building\n' "$link" >&2
    return 0
  fi
  find "$@" -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-16
}

cache_lock_shared() {
  exec 9>>"$RUMAQ_CACHE_DIR/.lock" || return 1
  flock -s 9
}

cache_lock_exclusive() {
  exec 9>>"$RUMAQ_CACHE_DIR/.lock" || return 1
  flock -x 9
}

cache_unlock() {
  flock -u 9 2>/dev/null || true
}

# cache_restore <name> <stamp> <destination>
# Restores a cached artifact into <destination> on a hit. Returns 1 on a miss
# or any doubt — the caller rebuilds.
cache_restore() {
  local name="${1:-}" want="${2:-}" dest="${3:-}" dir tmp cached
  cache_enabled || return 1
  dir="$RUMAQ_CACHE_DIR/$name"
  [[ -f "$dir/stamp" ]] || return 1
  cache_lock_shared || return 1
  cached="$(cat "$dir/stamp" 2>/dev/null || true)"
  if [[ "$cached" == "$want" && -d "$dir/artifact" ]]; then
    tmp="${dest}.cache.$$"
    rm -rf "$tmp"
    # Copy beside the destination first, then swap: a concurrent writer can
    # never expose a half-written artifact to the build.
    if cp -a "$dir/artifact" "$tmp" 2>/dev/null; then
      rm -rf "$dest"
      mv -T "$tmp" "$dest" 2>/dev/null &&
        {
          cache_unlock
          return 0
        }
    fi
    rm -rf "$tmp"
  fi
  cache_unlock
  return 1
}

# cache_store <name> <stamp> <source>
# Publishes <source> under the stamp, serialized against every other container
# sharing the volume. Best effort: a failure here only costs a rebuild.
cache_store() {
  local name="${1:-}" want="${2:-}" src="${3:-}" dir tmp cached
  cache_enabled || return 0
  dir="$RUMAQ_CACHE_DIR/$name"
  mkdir -p "$dir" 2>/dev/null || return 0
  cache_lock_exclusive || return 0
  cached="$(cat "$dir/stamp" 2>/dev/null || true)"
  if [[ "$cached" == "$want" && -d "$dir/artifact" ]]; then
    cache_unlock
    return 0
  fi
  tmp="$dir/write.$$"
  rm -rf "$tmp"
  if cp -a "$src" "$tmp" 2>/dev/null; then
    rm -rf "$dir/artifact"
    if mv -T "$tmp" "$dir/artifact" 2>/dev/null; then
      printf '%s\n' "$want" >"$dir/stamp.new.$$" &&
        mv -T "$dir/stamp.new.$$" "$dir/stamp" 2>/dev/null
    else
      rm -rf "$tmp"
    fi
  else
    rm -rf "$tmp"
  fi
  cache_unlock
  return 0
}
