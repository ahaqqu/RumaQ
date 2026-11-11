#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# test-runner container entrypoint (ahaqqu/RumaQ#356)
# ============================================================
# Toolchain-only image: bun, Playwright + Chromium and the installed
# dependencies are baked in; automation/tests, automation/playwright.config.js,
# backend/src and contract/src are read-only mounts (the step files import the
# backend's auth helper and the contract package directly).
#
# Playwright-BDD generation runs here, at container start, so adding a feature
# or a step needs no image rebuild. The content-hash cache skips it entirely on
# an unedited tree; a hit or miss never changes which tests run.
# ============================================================

source /usr/local/bin/build-cache.sh
cd /app

want="$(cache_stamp automation/tests automation/playwright.config.js)"

if cache_restore bdd "$want" /app/automation/.features-gen; then
  echo "test-runner: BDD cache hit (${want})"
else
  if cache_enabled; then
    echo "test-runner: BDD cache miss (${want}) - generating Playwright-BDD tests"
  else
    echo 'test-runner: build cache disabled - generating Playwright-BDD tests'
  fi
  bunx bddgen test --config automation/playwright.config.js
  cache_store bdd "$want" automation/.features-gen
fi

exec "$@"
