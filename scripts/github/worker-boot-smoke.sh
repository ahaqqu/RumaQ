#!/usr/bin/env bash
set -euo pipefail

# Boots the REAL bundled Worker inside workerd and asserts GET /api/health
# (ahaqqu/RumaQ#534).
#
# Why this exists: backend/src/lib/ai/legacy.ts built an AbortController at
# module scope (#533), which workerd forbids during bundle evaluation — the
# Worker could not start AT ALL, yet every PR check passed and the break
# merged. Unit tests never catch it: they call `app.request()` on the Hono app
# in Node, which evaluates no Worker bundle and runs under no workerd rules.
# The only job that boots the real Worker is the Docker/automation stack in
# test-automation.yml, and that runs on a nightly schedule.
#
# This gate uses the same build path as dev and deploy: @cloudflare/vite-plugin's
# `vp build backend` (Workers Build Output Specification) produces the bundle.
# That ONE bundle is then booted twice in workerd:
#
#   1. `vp preview backend` — the plugin's own preview runtime (the one dev,
#      previews and deploys use). It serves the bundle over HTTP; a
#      module-scope forbidden call fails startup and /api/health never answers.
#   2. scripts/ci/worker-boot-harness.mjs — the repo's pinned `miniflare`
#      dev dependency, which is the runtime the nightly Docker/automation
#      harness boots (automation/tests/support/worker-server.mjs).
#
# Both boots are required because they ship different workerd versions and
# disagree on global-scope restrictions: the plugin's newer workerd accepts
# `new AbortController()` at module scope, while the pinned one (the runtime
# #533 actually broke) rejects it. Only running the plugin runtime would let
# that line pass PRs and fail the nightly again — exactly #534's failure mode.
#
# No secrets, no D1 migrations, no Docker: /api/health is a static JSON handler,
# and `RUN_SECRETS_CHECK` resolves to false while CLOUDFLARE_ACCOUNT_ID is unset
# (cloudflare.config.ts treats that as the LOCAL environment). The full
# 150/53 automation matrix stays nightly — keep this under a minute once
# dependencies are installed.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# A free port picked by the OS, not a fixed one: a stale dev/preview server on
# 8787 would otherwise answer the health poll and make this gate pass while the
# freshly built Worker never started (`--strictPort` would have exited it).
free_port() {
  node -e '
    const server = require("node:net").createServer()
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port)
      server.close()
    })
  '
}

PORT="${WORKER_BOOT_PORT:-$(free_port)}"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/worker-boot-smoke.XXXXXX.log")"
BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/worker-boot-smoke-body.XXXXXX")"
PREVIEW_PID=""

info() { echo -e "==> $1"; }
ok() { echo -e "  ✓  $1"; }

dump_log() {
  if [[ -s "$LOG_FILE" ]]; then
    echo "--- vp preview output ---"
    cat "$LOG_FILE"
    echo "--- end vp preview output ---"
  fi
}

cleanup() {
  if [[ -n "$PREVIEW_PID" ]] && kill -0 "$PREVIEW_PID" 2>/dev/null; then
    kill "$PREVIEW_PID" 2>/dev/null || true
    # Give the preview server a moment to shut workerd down cleanly; a hung
    # process must not hang the CI job.
    for _ in $(seq 1 10); do
      kill -0 "$PREVIEW_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$PREVIEW_PID" 2>/dev/null || true
    wait "$PREVIEW_PID" 2>/dev/null || true
  fi
  rm -f "$BODY_FILE" "$LOG_FILE"
}

fail() {
  echo -e "  ✗  $1" >&2
  dump_log
  exit 1
}

trap cleanup EXIT

cd "$ROOT_DIR"

# The Worker build packs frontend/dist into its static assets and the preview
# server needs that directory to exist (the ASSETS binding). CI's earlier
# `scripts/build.sh` already produces it; build it only when missing so a local
# run works without duplicating CI's work.
if [[ ! -f frontend/dist/index.html ]]; then
  info "frontend/dist missing — building the frontend for the Worker's assets"
  node node_modules/.bin/vp build frontend
fi

info "Building the Worker bundle (vp build backend)"
node node_modules/.bin/vp build backend

# LOCAL environment on purpose: an inherited account id would flip
# RUN_SECRETS_CHECK to true and make every request answer the startup
# missing-secrets 500 instead of reaching the routes under test.
unset CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_DATABASE_ID

info "Boot 1/2: plugin preview serving the bundle in workerd (${BASE_URL})"
# --host 127.0.0.1: Vite's preview server otherwise binds only ::1 (IPv6
# localhost), so a curl to 127.0.0.1 never connects.
node node_modules/.bin/vp preview backend --port "$PORT" --strictPort --host 127.0.0.1 >"$LOG_FILE" 2>&1 &
PREVIEW_PID=$!

# Startup is a few seconds; the deadline is generous so a cold runner never
# flakes, and a dead preview process fails fast instead of waiting it out.
DEADLINE=$((SECONDS + 90))
STATUS=""
while (( SECONDS < DEADLINE )); do
  if ! kill -0 "$PREVIEW_PID" 2>/dev/null; then
    fail "vp preview exited before serving /api/health (the Worker failed to start / evaluate)"
  fi
  STATUS="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' --max-time 2 "$BASE_URL/api/health" 2>/dev/null || true)"
  case "$STATUS" in
    200) break ;;
    000 | "") sleep 1 ;;
    *)
      # Anything non-200 is a failure of the worker under test, not a race:
      # the dev/preview server is already answering.
      fail "GET /api/health returned HTTP ${STATUS}: $(cat "$BODY_FILE")"
      ;;
  esac
done

if [[ "$STATUS" != "200" ]]; then
  fail "GET /api/health never returned 200 within 90s (last status: ${STATUS:-none})"
fi

# The 200 must come from THIS run's preview server: if it died on a port
# conflict while another server happened to answer, that is not a pass.
if ! kill -0 "$PREVIEW_PID" 2>/dev/null; then
  fail "vp preview exited after serving /api/health — the response did not come from this build"
fi

if ! grep -q '"ok":true' "$BODY_FILE"; then
  fail "GET /api/health did not answer {\"ok\":true}: $(cat "$BODY_FILE")"
fi
ok "plugin preview runtime served GET /api/health → {\"ok\":true}"

info "Boot 2/2: the nightly harness runtime (pinned miniflare) on the same bundle"
node scripts/ci/worker-boot-harness.mjs

ok "Worker booted in both runtimes and served GET /api/health with {\"ok\":true} (${SECONDS}s)"
