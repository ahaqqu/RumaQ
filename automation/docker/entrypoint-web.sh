#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# web container entrypoint (ahaqqu/RumaQ#356)
# ============================================================
# Toolchain-only image: bun, nginx, dependencies and the build configs are
# baked in; frontend/src and frontend/public are read-only mounts. The SPA is
# built here, at container start, and copied into nginx's document root.
#
# Serving frontend/public closes a production-parity gap: the previous
# Dockerfile built the SPA at image time and served a bundle without the PWA
# icons/robots.txt that production ships.
# ============================================================

source /usr/local/bin/build-cache.sh
cd /app

want="$(cache_stamp frontend/src frontend/public)"

if cache_restore web "$want" /app/frontend/dist; then
  echo "web: build cache hit (${want})"
else
  if cache_enabled; then
    echo "web: build cache miss (${want}) - building the SPA"
  else
    echo 'web: build cache disabled - building the SPA'
  fi
  bunx vp build frontend
  cache_store web "$want" frontend/dist
fi

rm -rf /usr/share/nginx/html
mkdir -p /usr/share/nginx/html
cp -a frontend/dist/. /usr/share/nginx/html/

exec "$@"
