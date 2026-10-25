#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# needs-deploy.sh — decide whether a production deploy is needed
# ============================================================
# Used by CI (.github/workflows/deploy.yml) to skip a deploy when a push to
# main only touches files that target cannot care about.
#
# Usage:
#   needs-deploy.sh <base_ref> <head_ref> [target]
#
#   target cloudflare (default) — anything outside NO_DEPLOY_PATHSPECS
#          (docs, workflows, ...) deploys the Worker.
#   target vps — only the scraper's world deploys the box: the scraper/
#          and contract/ packages, the workspace manifests, and the VPS
#          deploy path itself. Everything else (backend, frontend, docs)
#          never reaches /srv/rumaq-scraper.
#
# Prints "true" or "false".
# ============================================================

BASE=${1:?base ref required}
HEAD=${2:?head ref required}
TARGET=${3:-cloudflare}

# A zero base ref means the previous head of main is unknown
# (new branch or force push) — deploy to be safe.
if [[ $BASE =~ ^0+$ ]]; then
  echo "true"
  exit 0
fi

if [[ $TARGET == vps ]]; then
  VPS_DEPLOY_PATHSPECS=(
    'scraper'
    'contract'
    'package.json'
    'bun.lock'
    'scripts/deploy.sh'
    'scripts/deploy'
  )
  changed=$(git diff --name-only "$BASE" "$HEAD" -- "${VPS_DEPLOY_PATHSPECS[@]}")
else
  NO_DEPLOY_PATHSPECS=(
    ':!*.md'
    ':!docs'
    ':!.agents'
    ':!.github'
    ':!LICENSE'
    ':!.gitignore'
    ':!.gitattributes'
  )
  changed=$(git diff --name-only "$BASE" "$HEAD" -- . "${NO_DEPLOY_PATHSPECS[@]}")
fi

if [[ -n $changed ]]; then
  echo "true"
else
  echo "false"
fi
