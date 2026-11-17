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
#
# The verdict protocol is lib/scope-verdict.sh: stdout "run|skip <why>",
# exit 0; an error prints no verdict and exits non-zero (audit M1).
set -uo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib/scope-verdict.sh"

scope_gate_main e2e-smoke e2e-smoke \
  "change set is docs, skills, Markdown, or repo meta" \
  "a changed path can reach the smoke" "$@"
