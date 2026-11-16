#!/usr/bin/env bash
# Decides whether the change set can reach a generated artifact, so CI and
# `scripts/check.sh` can skip a regeneration that cannot have drifted.
#
#   reaches.sh api      # docs/API.md + the typed client
#   reaches.sh deps     # the installed dependency tree (bun audit)
#
# Skips only when no changed path is an input of that generator; an unknown
# workspace or an unavailable change set runs it (fail safe — a wasted second,
# never a missed drift). --from-stdin reads the path list from stdin, which the
# offline guard uses.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 0

target=${1:-}
shift || true

case "$target" in
  api)
    # Paths the generator reads: backend routes, the contract, the codegen
    # tool, their manifests, and the generated file itself (a hand edit must
    # fail the drift check, not skip it).
    inputs='^(backend/|contract/|tools/codegen/|docs/API\.md$|scripts/docs\.sh$|.*package\.json$|bun\.lock$|\.npmrc$)'
    # Workspaces that cannot feed the generator. Anything outside them
    # (backend/, contract/, tools/, a new top-level directory) runs.
    skippable='^(frontend/|docs/|automation/|\.agents/|\.github/|scripts/|.*\.md$|LICENSE$|\.gitignore$|\.gitattributes$)'
    label='the API docs or the typed client'
    ;;
  deps)
    inputs='^(bun\.lock$|.*package\.json$|\.npmrc$|patches/)'
    skippable=''
    label='the dependency tree'
    ;;
  *)
    echo "usage: reaches.sh <api|deps> [--from-stdin]" >&2
    exit 2
    ;;
esac

if [ "${1:-}" = "--from-stdin" ]; then
  changed=$(cat)
else
  changed=$(bash "$root/scripts/github/changed-paths.sh")
fi

paths=$(printf '%s\n' "$changed" | sed '/^[[:space:]]*$/d')

if [ -z "$paths" ]; then
  echo "reach($target): no change set available — running (fail safe)"
  exit 0
fi

if printf '%s\n' "$paths" | grep -qE "$inputs"; then
  echo "reach($target): a changed path can reach $label — running"
  exit 0
fi

# Outside the known non-feeding workspaces is treated as an input: fail safe.
if [ -n "$skippable" ] && printf '%s\n' "$paths" | grep -qvE "$skippable"; then
  echo "reach($target): a changed path is outside the known skip set — running"
  exit 0
fi

echo "reach($target): change set cannot reach $label — skipped"
exit 1
