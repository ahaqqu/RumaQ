#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# needs-deploy.sh — decide whether a production deploy is needed
# ============================================================
# Used by CI (ci.yml deploy job) to skip the deploy when a push to
# main only touches deploy-irrelevant files (docs, workflows, ...).
#
# Usage:
#   needs-deploy.sh <base_ref> <head_ref>
#
# Prints "true" or "false". Paths considered deploy-irrelevant are
# listed in NO_DEPLOY_PATHSPECS below; anything else deploys.
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
