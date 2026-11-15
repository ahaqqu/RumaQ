#!/usr/bin/env bash
# Decides whether the PR E2E smoke is worth running (#657 phase 2).
#
# Run when any changed path can reach the app or the automation harness.
# Skip only when every changed path is docs, a skill, Markdown, LICENSE,
# .gitignore, or an issue/PR template — change sets that cannot make the
# three @smoke scenarios behave differently. The workflow itself, .gitattributes,
# and ANY unknown path run (fail safe): a wasted few minutes is better than a
# missed regression, and the check stays required-check-safe because the
# workflow always reports a result (no workflow-level paths: filter).
#
# --from-stdin takes the path list from stdin, which the offline guard test
# uses and a shell can use to check a hypothetical change set. Without it the
# list comes from changed-paths.sh, which carries the change-set resolution.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

# Paths that cannot change what the smoke exercises (app boot, receipt scan
# flow, price sort). Deliberately narrower than worker-smoke-scope's: the
# automation harness IS under test here, so automation/ runs.
skippable='^(docs/|\.agents/|.*\.md$|LICENSE$|\.gitignore$|\.github/ISSUE_TEMPLATE/|\.github/PULL_REQUEST_TEMPLATE)'

if [ "${1:-}" = "--from-stdin" ]; then
  changed=$(cat)
else
  changed=$(bash "$root/scripts/github/changed-paths.sh")
fi

if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
  echo "e2e-smoke: no change set available — running (fail safe)"
  exit 0
fi

if printf '%s\n' "$changed" | grep -v '^[[:space:]]*$' | grep -qvE "$skippable"; then
  echo "e2e-smoke: a changed path can reach the smoke — running"
  exit 0
fi

echo "e2e-smoke: change set is docs, skills, Markdown, or repo meta — skipped"
printf '%s\n' "$changed" | grep -v '^[[:space:]]*$' | head -5 | sed 's/^/  /'
exit 1
