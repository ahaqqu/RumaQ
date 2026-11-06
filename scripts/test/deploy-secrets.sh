#!/usr/bin/env bash
set -euo pipefail

# Guard test for ahaqqu/RumaQ#456.
#
# The CI deploy must never write the HAQITA_INGEST_SECRET Worker secret. That
# secret is set and rotated out-of-band (operator-owned); a deploy that
# re-asserts the repo's stale copy silently clobbers the rotated Worker value
# and 401s every internal endpoint (agent polling, brochures, run-report,
# ingest). This test enforces the rule on the deploy surfaces:
#
#   1. scripts/deploy.sh manages EXACTLY the four gateway secrets — asserted on
#      the array contents, not on the absence of one string, so dropping a
#      gateway secret also fails.
#   2. every `workers secrets update` in scripts/deploy.sh is driven by the
#      loop variable, never a hard-coded secret name.
#   3. the deploy workflow's Deploy production step passes the four gateway
#      secrets and not the ingest secret.
#   4. no workflow that invokes scripts/deploy.sh may hand the ingest secret to
#      that step — in any YAML spelling (an `env:` key, a quoted key, or an
#      inline `VAR=…` prefix on a `run:` line). A workflow that does not deploy
#      may still read it (the smoke freshness check does), but must never run a
#      `workers secrets update`.
#   5. only scripts/deploy.sh writes Worker secrets — no scripts/github helper
#      may open a second write path.
#
# Offline only: reads repository files, no network, no cf, no credentials.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_SH="$ROOT_DIR/scripts/deploy.sh"
DEPLOY_WF="$ROOT_DIR/.github/workflows/deploy.yml"
WORKFLOW_DIR="$ROOT_DIR/.github/workflows"
SECRET="HAQITA_INGEST_SECRET"
GATEWAY_SECRETS=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET WORKER_JWT_SECRET WORKER_ENCRYPTION_KEY)
EXPECTED="$(printf '%s\n' "${GATEWAY_SECRETS[@]}" | sort | tr '\n' ' ' | sed 's/ $//')"

failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ#456)\n' "$1" >&2
  failures=$((failures + 1))
}

print_list() {
  if (($# == 0)); then
    printf '<none>'
  else
    printf '%s\n' "$@" | sort | tr '\n' ' ' | sed 's/ $//'
  fi
}

# ------------------------------------------------------------------
# 1 + 2. scripts/deploy.sh: managed-secret array and update calls
# ------------------------------------------------------------------
echo "==> scripts/deploy.sh"

mapfile -t array_lines < <(grep -nE '^[[:space:]]*MANAGED_SECRETS=\(' "$DEPLOY_SH" || true)
if ((${#array_lines[@]} != 1)); then
  fail "expected exactly one MANAGED_SECRETS array in scripts/deploy.sh, found ${#array_lines[@]}"
else
  # Read the assignment across lines up to the closing paren, so a reformatted
  # multi-line array still yields its exact contents instead of slipping past.
  # Comment lines are skipped: the natural place to document "HAQITA_INGEST_SECRET
  # is deliberately absent" is inside this array, and its words must not leak
  # into the parsed set.
  array_list="$(awk '
    /^[[:space:]]*MANAGED_SECRETS=\(/ { in_array = 1 }
    in_array && /^[[:space:]]*#/ { next }
    in_array { printf "%s ", $0 }
    in_array && /\)/ { exit }
  ' "$DEPLOY_SH")"
  array_list="${array_list#*(}"
  array_list="${array_list%)*}"
  array_list="${array_list//$'\n'/ }"
  read -r -a managed <<< "$array_list"
  if ((${#managed[@]} == 0)); then
    fail "MANAGED_SECRETS in scripts/deploy.sh is empty"
  else
    actual="$(print_list "${managed[@]}")"
    if [[ "$actual" == "$EXPECTED" ]]; then
      pass "MANAGED_SECRETS is exactly the four gateway secrets: $actual"
    else
      # $SECRET is absent from EXPECTED, so re-adding it fails right here;
      # reporting it a second time would claim a `workers secrets update` bug
      # that the array alone cannot prove.
      fail "MANAGED_SECRETS must be exactly [${EXPECTED}], got [${actual}]"
    fi
  fi
fi

# The update must run inside the MANAGED_SECRETS loop, so a later edit cannot
# pin it to a literal or to one element and silently stop managing the rest.
# The variable name is read from the loop itself — renaming it is not a defect.
loop_var="$(grep -oE 'for [a-zA-Z_]+ in .*MANAGED_SECRETS\[@\]' "$DEPLOY_SH" | head -1 | awk '{print $2}')"
mapfile -t update_lines < <(grep -nE 'workers secrets update' "$DEPLOY_SH" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
if ((${#update_lines[@]} == 0)); then
  fail "no 'workers secrets update' invocation found in scripts/deploy.sh (parser out of date)"
elif [[ -z $loop_var ]]; then
  fail 'no loop over "${MANAGED_SECRETS[@]}" found in scripts/deploy.sh (parser out of date)'
else
  loop_ref="\"\$$loop_var\""
  for line in "${update_lines[@]}"; do
    if [[ "$line" != *"$loop_ref"* ]]; then
      fail "workers secrets update must use the loop variable $loop_ref: ${line#*:}"
    fi
  done
fi

# Every secret-name loop must iterate MANAGED_SECRETS. A literal list here would
# be a second copy of the managed set that the assertion above cannot see.
mapfile -t literal_lists < <(grep -nE 'for [a-zA-Z_]+ in [A-Z_]+( [A-Z_]+)+' "$DEPLOY_SH" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
if ((${#literal_lists[@]} == 0)); then
  pass 'no secret loop spells the managed set out literally'
else
  for line in "${literal_lists[@]}"; do
    fail "secret loop must iterate \"\${MANAGED_SECRETS[@]}\", not a literal list: ${line#*:}"
  done
fi

# The name may appear in scripts/deploy.sh only inside comments.
mapfile -t secret_refs < <(grep -nF "$SECRET" "$DEPLOY_SH" || true)
for ref in "${secret_refs[@]}"; do
  text="${ref#*:}"
  if [[ ! "$text" =~ ^[[:space:]]*# ]]; then
    fail "scripts/deploy.sh references $SECRET outside a comment: ${text}"
  fi
done

# ------------------------------------------------------------------
# 3. .github/workflows/deploy.yml: Deploy production step env
# ------------------------------------------------------------------
echo "==> .github/workflows/deploy.yml"

step_block="$(awk '
  /^      - (name|uses):/ && /Deploy production/ { in_step = 1 }
  in_step && /^      - (name|uses):/ && !/Deploy production/ { in_step = 0 }
  in_step { print }
' "$DEPLOY_WF")"

if [[ -z "$step_block" ]]; then
  fail "could not locate the Deploy production step in .github/workflows/deploy.yml"
else
  if grep -qE "^[[:space:]]*${SECRET}:" <<< "$step_block"; then
    fail ".github/workflows/deploy.yml passes $SECRET into the Deploy production env"
  else
    pass "Deploy production env does not pass $SECRET"
  fi

  for name in "${GATEWAY_SECRETS[@]}"; do
    if grep -qE "^[[:space:]]*${name}:[[:space:]]*\\$\\{\\{ secrets\\.${name} \\}\\}$" <<< "$step_block"; then
      pass "Deploy production env still passes $name"
    else
      fail "Deploy production env must still pass $name from secrets"
    fi
  done

  if grep -qE 'scripts/deploy\.sh' <<< "$step_block"; then
    pass "Deploy production still invokes scripts/deploy.sh"
  else
    fail "Deploy production step no longer invokes scripts/deploy.sh (guard inspected the wrong block)"
  fi
fi

# ------------------------------------------------------------------
# 4. Every workflow: deploys never receive it, readers never write it
# ------------------------------------------------------------------
echo "==> .github/workflows (deploy + secret-writing workflows)"

# A line that mentions the secret only in a YAML comment is documentation, not a
# value handed to a step (deploy.yml explains the omission in one).
workflow_code() { grep -vE '^[[:space:]]*#' "$1" || true; }

shopt -s nullglob
for wf in "$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml; do
  wf_name="$(basename "$wf")"
  code="$(workflow_code "$wf")"
  grep -qF "$SECRET" <<< "$code" || continue

  # Every spelling that hands the secret to a step — `KEY: ${{ secrets.X }}`,
  # `"KEY": …`, or an inline `KEY=… ` prefix on a run: line — leaves the bare
  # name on a non-comment line, so YAML formatting cannot dodge this check.
  if grep -qE 'scripts/deploy\.sh' <<< "$code"; then
    fail "$wf_name hands $SECRET to a step that runs scripts/deploy.sh"
    continue
  fi

  # Not a deploy workflow: the secret may be read (authenticated GETs) but never
  # written. Checking only for scripts/deploy.sh let a direct
  # `cf workers secrets update` read as a "read-only" pass.
  if grep -qE 'workers secrets (update|bulk)|workers secret put|secrets-bulk' <<< "$code"; then
    fail "$wf_name runs a Worker secrets write while referencing $SECRET"
  else
    pass "$wf_name reads $SECRET (no deploy, no secrets-write command)"
  fi
done
shopt -u nullglob

# ------------------------------------------------------------------
# 5. scripts/github/*: scripts/deploy.sh stays the only write path
# ------------------------------------------------------------------
echo "==> scripts/github (CI helper scripts)"
secret_writers=0
for helper in "$ROOT_DIR"/scripts/github/*.sh; do
  if grep -vE '^[[:space:]]*#' "$helper" | grep -qE 'workers secrets (update|bulk)|workers secret put'; then
    fail "$(basename "$helper") writes Worker secrets — scripts/deploy.sh is the single deploy entrypoint"
    secret_writers=$((secret_writers + 1))
  fi
done
if ((secret_writers == 0)); then
  pass "no scripts/github helper writes Worker secrets"
fi

# ------------------------------------------------------------------
# Result
# ------------------------------------------------------------------
echo ""
if ((failures > 0)); then
  echo "deploy-secrets: FAILED — ${failures} assertion(s) violated (ahaqqu/RumaQ#456)." >&2
  echo "The CI deploy must never write the operator-owned $SECRET." >&2
  exit 1
fi

echo "deploy-secrets: OK — CI never writes $SECRET."
