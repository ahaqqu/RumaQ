#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# needs-deploy.sh — decide whether a production deploy is needed
# ============================================================
# Used by CI (.github/workflows/deploy.yml) to skip a deploy when a push to
# main only touches files the Worker cannot care about.
#
# Usage:
#   needs-deploy.sh <base_ref> <head_ref>
#
# Anything outside NO_DEPLOY_PATHSPECS (docs, workflows, ...) deploys the
# Worker. The scraper box is deployed by the private RumaQ-pipeline repo.
#
# Prints "true" or "false".
# ============================================================

BASE=${1:?base ref required}
HEAD=${2:?head ref required}

# A zero base ref means the previous head of main is unknown
# (new branch or force push) — deploy to be safe.
if [[ $BASE =~ ^0+$ ]]; then
  echo "true"
  exit 0
fi

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

if [[ -n $changed ]]; then
  echo "true"
else
  echo "false"
fi
