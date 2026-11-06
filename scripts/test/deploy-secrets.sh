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
#   4. no workflow that invokes scripts/deploy.sh may pass the ingest secret
#      into a step env.
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

mapfile -t array_lines < <(grep -nE '^[[:space:]]*local secrets=\(' "$DEPLOY_SH" || true)
if ((${#array_lines[@]} != 1)); then
  fail "expected exactly one managed-secret array in scripts/deploy.sh, found ${#array_lines[@]}"
else
  # Read the assignment across lines up to the closing paren, so a reformatted
  # multi-line array still yields its exact contents instead of slipping past.
  array_list="$(awk '
    /^[[:space:]]*local secrets=\(/ { in_array = 1 }
    in_array { printf "%s ", $0 }
    in_array && /\)/ { exit }
  ' "$DEPLOY_SH")"
  array_list="${array_list#*(}"
  array_list="${array_list%)*}"
  array_list="${array_list//$'\n'/ }"
  read -r -a managed <<< "$array_list"
  if ((${#managed[@]} == 0)); then
    fail "the managed-secret array in scripts/deploy.sh is empty"
  else
    actual="$(print_list "${managed[@]}")"
    if [[ "$actual" == "$EXPECTED" ]]; then
      pass "managed-secret array is exactly the four gateway secrets: $actual"
    else
      fail "managed-secret array must be exactly [${EXPECTED}], got [${actual}]"
    fi
    for name in "${managed[@]}"; do
      if [[ "$name" == "$SECRET" ]]; then
        fail "scripts/deploy.sh still passes $SECRET to workers secrets update"
      fi
    done
  fi
fi

mapfile -t update_lines < <(grep -nE 'workers secrets update' "$DEPLOY_SH" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
if ((${#update_lines[@]} == 0)); then
  fail "no 'workers secrets update' invocation found in scripts/deploy.sh (parser out of date)"
else
  for line in "${update_lines[@]}"; do
    if [[ "$line" != *'"$name"'* ]]; then
      fail "workers secrets update must be driven by the loop variable: ${line#*:}"
    fi
  done
fi

# Any secret-name loop must still cover exactly the deploy-managed set.
mapfile -t loop_lists < <(grep -oE 'for secret_name in [A-Z_]+( [A-Z_]+)*' "$DEPLOY_SH" || true)
if ((${#loop_lists[@]} == 0)); then
  fail "no 'for secret_name in ...' loop found in scripts/deploy.sh (parser out of date)"
else
  for list in "${loop_lists[@]}"; do
    read -r -a names <<< "${list#for secret_name in }"
    actual="$(print_list "${names[@]}")"
    if [[ "$actual" == "$EXPECTED" ]]; then
      pass "secret loop covers the four gateway secrets"
    else
      fail "secret loop must cover exactly [${EXPECTED}], got [${actual}]"
    fi
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
# 4. Every workflow: no deploy workflow may pass the secret
# ------------------------------------------------------------------
echo "==> .github/workflows (deploy workflows)"

for wf in "$WORKFLOW_DIR"/*.yml; do
  wf_name="$(basename "$wf")"
  if ! grep -qE "^[[:space:]]*${SECRET}:" "$wf"; then
    continue
  fi
  if grep -qE 'scripts/deploy\.sh' "$wf"; then
    fail "$wf_name passes $SECRET into a step env while invoking scripts/deploy.sh"
  else
    pass "$wf_name references $SECRET only outside a deploy (read-only check)"
  fi
done

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
