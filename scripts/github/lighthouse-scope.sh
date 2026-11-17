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
#
# The verdict protocol is lib/scope-verdict.sh: stdout "run|skip <why>",
# exit 0; an error prints no verdict and exits non-zero (audit M1).
set -uo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib/scope-verdict.sh"

scope_gate_main lighthouse lighthouse-scope \
  "change set cannot reach the frontend bundle" \
  "a changed path can reach the frontend bundle" "$@"
