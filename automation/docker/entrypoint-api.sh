#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# api container entrypoint (ahaqqu/RumaQ#356)
# ============================================================
# The image is toolchain-only: dependencies (including node-real for the
# Cloudflare build config), configs and the empty frontend/dist asset root are
# baked in; backend/src, contract/src, backend/migrations and automation/tests
# are read-only bind mounts. The Worker bundle is therefore built here, at
# container start, from whatever the mounts hold — no image rebuild after a
# source edit, and never a stale bundle.
#
# The content-hash cache (build-cache.sh) turns that build into a copy on an
# unedited tree. A miss, a corrupt entry or a disabled cache just builds.
# ============================================================

source /usr/local/bin/build-cache.sh
cd /app

want="$(cache_stamp backend/src contract/src)"

if cache_restore api "$want" /app/backend/.cloudflare; then
  echo "api: build cache hit (${want})"
else
  if cache_enabled; then
    echo "api: build cache miss (${want}) - building the Worker bundle"
  else
    echo 'api: build cache disabled - building the Worker bundle'
  fi
  # The Worker build packs frontend/dist as static assets; the harness serves
  # the SPA through nginx instead, so the empty directory is enough.
  mkdir -p frontend/dist
  # node-real, not the bun `node` shim: cloudflare.config.ts is loaded by real
  # Node >= 22.18 (see Dockerfile.api).
  node-real node_modules/.bin/vp build backend
  cache_store api "$want" backend/.cloudflare
fi

exec "$@"
