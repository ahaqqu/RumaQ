#!/usr/bin/env bash
# Lists the changed paths of the current change set, one per line. Scope gates
# (worker-smoke-scope.sh, lighthouse-scope.sh) apply their own policy to the
# list; this script carries no policy.
#
# Resolution order:
#   - Pull request (GITHUB_BASE_REF): three-dot diff against the base branch's
#     current tip — correct whether or not the branch is behind it.
#   - Pull request (PR_BASE_SHA, no ref): the event's base object, two-dot;
#     exact only while that object is the merge base.
#   - Local branch: diff against origin/main.
#   - Main push: squash merges leave the merged files on HEAD's own commit.
#
# Uncommitted work counts too, so a local run reflects the tree it audits.
# Prints nothing when no change set is available; callers treat that as
# "unknown" and fail safe.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

# Callers that already resolved the set (ci.sh, check.sh) export CHANGED_PATHS
# so every gate below reads one answer instead of repeating the fetch. An
# exported-but-empty value means "unknown", which the callers treat as fail
# safe — the same contract as an empty stdout.
if [ -n "${CHANGED_PATHS+x}" ]; then
  printf '%s\n' "$CHANGED_PATHS"
  exit 0
fi

base_sha=${PR_BASE_SHA:-}
base=${GITHUB_BASE_REF:-}
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

if [ -n "$base" ]; then
  # Pull request: three-dot diff against the base branch's CURRENT tip. The
  # event's base_sha can be the fork point rather than the tip, and a two-dot
  # diff against it also lists everything the base gained since — a docs-only
  # PR behind main then looks like it touches backend files, and every scope
  # gate runs (#695).
  #
  # A shallow CI checkout has no merge base to three-dot from, so deepen the
  # PR's own refs and the base together: depth 50 covers any realistic PR
  # lifetime, and a deeper gap fails safe (the caller runs).
  refs=("+refs/heads/$base:refs/remotes/origin/$base")
  case ${GITHUB_REF:-} in
    refs/pull/*/merge)
      pr=${GITHUB_REF#refs/pull/}
      refs+=("+refs/pull/${pr%%/*}/merge:refs/remotes/origin/pr-merge")
      ;;
  esac
  if [ -f "$(git rev-parse --absolute-git-dir 2>/dev/null)/shallow" ]; then
    depth=(--depth=50)
  else
    depth=()
  fi
  for ref in "${refs[@]}"; do
    git fetch --quiet --no-tags "${depth[@]}" origin "$ref" 2>/dev/null || true
  done
  if git rev-parse -q --verify "refs/remotes/origin/$base" >/dev/null 2>&1; then
    git diff --name-only "origin/$base...HEAD" 2>/dev/null
  fi
elif [ -n "$base_sha" ]; then
  # Fallback when the base ref is unavailable: the exact base object. Two-dot
  # is correct only while that object is the merge base — best effort.
  if git fetch --quiet --no-tags --depth=1 origin "$base_sha" 2>/dev/null; then
    git diff --name-only FETCH_HEAD HEAD
  fi
elif [ "$branch" != "main" ] && git rev-parse --verify -q origin/main >/dev/null 2>&1; then
  git diff --name-only origin/main...HEAD 2>/dev/null
else
  # Main push: squash merges leave the merged files on HEAD's own commit.
  git show --pretty=format: --name-only HEAD 2>/dev/null
fi

# Uncommitted work counts too, so a local run reflects the tree it audits.
git status --porcelain 2>/dev/null | cut -c4-
