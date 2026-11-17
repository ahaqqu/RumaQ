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
#
# The verdict protocol is lib/scope-verdict.sh: stdout "run|skip <why>",
# exit 0; an error prints no verdict and exits non-zero (audit M1). The policy
# stays inline: this gate triggers on positive generator inputs, not on a
# skip set, so the skippable-paths.txt table does not shape it.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || {
  echo "reaches: cannot enter the repository root" >&2
  exit 3
}

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

case "${1:-}" in
  '') changed=$(bash "$root/scripts/github/changed-paths.sh") ;;
  --from-stdin) changed=$(cat) ;;
  *)
    echo "reaches: unknown argument $1 — usage: [--from-stdin]" >&2
    exit 2
    ;;
esac

paths=$(printf '%s\n' "$changed" | sed '/^[[:space:]]*$/d')

if [ -z "$paths" ]; then
  echo "run reach($target): no change set available — running (fail safe)"
  exit 0
fi

if printf '%s\n' "$paths" | grep -qE "$inputs"; then
  echo "run reach($target): a changed path can reach $label"
  exit 0
fi

# Outside the known non-feeding workspaces is treated as an input: fail safe.
if [ -n "$skippable" ] && printf '%s\n' "$paths" | grep -qvE "$skippable"; then
  echo "run reach($target): a changed path is outside the known skip set"
  exit 0
fi

echo "skip reach($target): change set cannot reach $label"
printf '%s\n' "$paths" | head -5 | sed 's/^/  /' >&2
exit 0
