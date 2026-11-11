#!/usr/bin/env bash
# Decides whether the Worker boot smoke is worth running (ahaqqu/RumaQ#534).
#
# Run when any changed path can reach the Worker bundle. Skip only when every
# changed path is docs, a skill, an automation test, or a Markdown file. An
# unavailable change set runs the smoke: the failure mode is a wasted minute,
# never a broken bundle that merges green.
#
# --from-stdin takes the path list from stdin, which the offline guard test
# uses and a shell can use to check a hypothetical change set.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

# Paths that cannot change the bundle built by `vp build backend`.
skippable='^(docs/|\.agents/|automation/|.*\.md$)'

collect() {
  local base_sha=${PR_BASE_SHA:-} base=${GITHUB_BASE_REF:-}
  local branch
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
}

if [ "${1:-}" = "--from-stdin" ]; then
  changed=$(cat)
else
  changed=$(collect)
fi

if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
  echo "worker-smoke: no change set available — running (fail safe)"
  exit 0
fi

if printf '%s\n' "$changed" | grep -v '^[[:space:]]*$' | grep -qvE "$skippable"; then
  echo "worker-smoke: a changed path can reach the Worker bundle — running"
  exit 0
fi

echo "worker-smoke: change set is docs, skills, tests, or Markdown — skipped"
printf '%s\n' "$changed" | grep -v '^[[:space:]]*$' | head -5 | sed 's/^/  /'
exit 1
