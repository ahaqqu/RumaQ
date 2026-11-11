#!/usr/bin/env bash
# Decides whether Lighthouse CI is worth running.
#
# Lighthouse audits frontend/dist, built by `vp build frontend` from frontend/
# plus the root toolchain. Skip only when every changed path provably cannot
# reach that bundle: docs, a skill, an automation test, Markdown, backend/ or
# contract/ sources (the frontend imports neither — the API client is
# generated and committed under frontend/src/lib/api-client), codegen tools
# (their outputs are the committed frontend artifacts), or scripts/ except
# scripts/build.sh, which produces the dist. .github/workflows and any unknown
# path run: the failure mode is a wasted half-minute, never a performance or
# accessibility regression that merges green.
#
# --from-stdin takes the path list from stdin, which the offline guard test
# uses and a shell can use to check a hypothetical change set. Without it the
# list comes from changed-paths.sh, which carries the change-set resolution.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

# True when the path cannot reach the frontend bundle. scripts/build.sh is the
# exception inside scripts/: ci.sh calls it to produce frontend/dist.
cannot_reach_dist() {
  case "$1" in
    docs/* | .agents/* | automation/* | *.md | backend/* | tools/* | contract/*) return 0 ;;
    scripts/build.sh) return 1 ;;
    scripts/*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "${1:-}" = "--from-stdin" ]; then
  changed=$(cat)
else
  changed=$(bash "$root/scripts/github/changed-paths.sh")
fi

if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
  echo "lighthouse-scope: no change set available — running (fail safe)"
  exit 0
fi

skipped=true
while IFS= read -r path; do
  [ -z "$path" ] && continue
  if ! cannot_reach_dist "$path"; then
    skipped=false
    break
  fi
done <<EOF
$changed
EOF

if [ "$skipped" = true ]; then
  echo "lighthouse-scope: change set cannot reach the frontend bundle — skipped"
  printf '%s\n' "$changed" | grep -v '^[[:space:]]*$' | head -5 | sed 's/^/  /'
  exit 1
fi

echo "lighthouse-scope: a changed path can reach the frontend bundle — running"
exit 0
