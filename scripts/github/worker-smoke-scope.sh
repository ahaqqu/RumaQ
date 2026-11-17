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
#
# The verdict protocol is lib/scope-verdict.sh: stdout "run|skip <why>",
# exit 0; an error prints no verdict and exits non-zero (audit M1).
set -uo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib/scope-verdict.sh"

scope_gate_main worker-smoke worker-smoke \
  "change set is docs, skills, tests, or Markdown" \
  "a changed path can reach the Worker bundle" "$@"
