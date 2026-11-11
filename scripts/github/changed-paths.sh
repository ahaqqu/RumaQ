#!/usr/bin/env bash
# Lists the changed paths of the current change set, one per line. Scope gates
# (worker-smoke-scope.sh, lighthouse-scope.sh) apply their own policy to the
# list; this script carries no policy.
#
# Resolution order:
#   - Pull request (PR_BASE_SHA): one object fetch reaches the exact base tree.
#   - Pull request (GITHUB_BASE_REF): diff against the base branch.
#   - Local branch: diff against origin/main.
#   - Main push: squash merges leave the merged files on HEAD's own commit.
#
# Uncommitted work counts too, so a local run reflects the tree it audits.
# Prints nothing when no change set is available; callers treat that as
# "unknown" and fail safe.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

base_sha=${PR_BASE_SHA:-}
base=${GITHUB_BASE_REF:-}
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

if [ -n "$base_sha" ]; then
  # Pull request: one object fetch reaches the exact base tree.
  if git fetch --quiet --no-tags --depth=1 origin "$base_sha" 2>/dev/null; then
    git diff --name-only FETCH_HEAD HEAD
  fi
elif [ -n "$base" ]; then
  git fetch --quiet --no-tags origin "refs/heads/$base:refs/remotes/origin/$base" 2>/dev/null || true
  git diff --name-only "origin/$base...HEAD" 2>/dev/null
elif [ "$branch" != "main" ] && git rev-parse --verify -q origin/main >/dev/null 2>&1; then
  git diff --name-only origin/main...HEAD 2>/dev/null
else
  # Main push: squash merges leave the merged files on HEAD's own commit.
  git show --pretty=format: --name-only HEAD 2>/dev/null
fi

# Uncommitted work counts too, so a local run reflects the tree it audits.
git status --porcelain 2>/dev/null | cut -c4-
