#!/usr/bin/env bash
# Decides whether the Worker boot smoke is worth running (ahaqqu/RumaQ#534).
#
# Run when any changed path can reach the Worker bundle. Skip only when every
# changed path is docs, a skill, an automation test, or a Markdown file. An
# unavailable change set runs the smoke: the failure mode is a wasted minute,
# never a broken bundle that merges green.
#
# --from-stdin takes the path list from stdin, which the offline guard test
# uses and a shell can use to check a hypothetical change set. Without it the
# list comes from changed-paths.sh, which carries the change-set resolution.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

# Paths that cannot change the bundle built by `vp build backend`.
skippable='^(docs/|\.agents/|automation/|.*\.md$)'

if [ "${1:-}" = "--from-stdin" ]; then
  changed=$(cat)
else
  changed=$(bash "$root/scripts/github/changed-paths.sh")
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
