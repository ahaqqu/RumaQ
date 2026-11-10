#!/usr/bin/env bash
set -euo pipefail

# Guard test for ahaqqu/RumaQ#536.
#
# A dead pipeline must not look quiet. Before #536 the freshness probe was
# end-of-day anchored AND skipped when observationCount == 0 — so a pipeline
# that never publishes (a quota outage, a broken publish leg) never tripped
# it, and a week of failed nights read as "no new prices yet". The new
# consecutive-failed-run branch must fire with zero observations, and the
# branch that already worked must keep its behaviour.
#
# This test runs the REAL scripts/github/check-price-freshness.sh against
# canned probe responses, with a `curl` shim first in PATH: the tested script
# is exercised end to end (jq shape-checks, thresholds, exit codes), offline,
# with no production URL and no secret.
#
#   ./scripts/test.sh freshness

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/github/check-price-freshness.sh"

if ! command -v jq >/dev/null 2>&1; then
  # The probe itself cannot run without jq, so neither can this test. Skip
  # loudly rather than pass vacuously.
  echo "price-freshness test: jq not installed — skipping (the probe needs it)"
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# The tested script's only network call is `curl`. Serve the canned response
# from this shim (SHIM_RESPONSE) or fail like a transport error.
mkdir -p "$TMP_DIR/bin"
cat >"$TMP_DIR/bin/curl" <<'SHIM'
#!/usr/bin/env bash
if [ "${SHIM_CURL_FAIL:-0}" = "1" ]; then
  exit 22
fi
cat "${SHIM_RESPONSE:?}"
SHIM
chmod +x "$TMP_DIR/bin/curl"

failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ#536)\n' "$1" >&2
  failures=$((failures + 1))
}

# run_case <name> <expected-exit> <probe-json> <expected-output-substring> [env...]
# The substring may be empty to skip the message check.
run_case() {
  local name="$1" expected="$2" json="$3" contains="$4"
  shift 4
  printf '%s' "$json" >"$TMP_DIR/response.json"

  local output status
  set +e
  output="$(
    env PATH="$TMP_DIR/bin:$PATH" \
      SHIM_RESPONSE="$TMP_DIR/response.json" \
      HAQITA_INGEST_SECRET="test-secret" \
      "$@" bash "$SCRIPT" 2>&1
  )"
  status=$?
  set -e

  # "nonzero" is for the transport case: the script dies on `set -e` at the
  # curl call, so the exact code is curl's, not ours — any failure will do.
  if [ "$expected" = "nonzero" ]; then
    if [ "$status" -eq 0 ]; then
      fail "$name (exit 0, expected a failure)"
      printf '%s\n' "$output" | sed 's/^/        /' >&2
      return 0
    fi
  elif [ "$status" -ne "$expected" ]; then
    fail "$name (exit ${status}, expected ${expected})"
    printf '%s\n' "$output" | sed 's/^/        /' >&2
    return 0
  fi
  if [ -n "$contains" ] && ! printf '%s' "$output" | grep -qF -- "$contains"; then
    fail "$name (output missing '${contains}')"
    printf '%s\n' "$output" | sed 's/^/        /' >&2
    return 0
  fi
  pass "$name"
}

TODAY="$(date -u +%F)"
STALE_DAY="$(date -ud '8 days ago' +%F)"

no_streak='{"count":0,"threshold":3,"since":null,"code":null}'
quota_streak='{"count":3,"threshold":3,"since":"2026-10-26T23:00:05Z","code":"embedding_unavailable"}'
short_streak='{"count":2,"threshold":3,"since":"2026-10-27T23:00:05Z","code":"embedding_unavailable"}'

echo "==> go-live pending (zero observations, nothing failing)"
run_case "zero observations + no streak skips" 0 \
  "{\"observationCount\":0,\"latestObservedDate\":null,\"failedStreak\":${no_streak}}" \
  "no observations yet"

echo "==> a dead pipeline with zero observations (the #536 hole)"
# The bug this ticket kills: observationCount == 0 used to short-circuit the
# probe, so this exact response passed as "go-live pending".
run_case "zero observations + 3 consecutive failed runs FAILS" 1 \
  "{\"observationCount\":0,\"latestObservedDate\":null,\"failedStreak\":${quota_streak}}" \
  "3 consecutive failed runs"

run_case "zero observations + 2 failed runs (below the threshold) still skips" 0 \
  "{\"observationCount\":0,\"latestObservedDate\":null,\"failedStreak\":${short_streak}}" \
  "no observations yet"

echo "==> the streak branch is not a zero-observation special case"
run_case "fresh observation + 3 consecutive failed runs FAILS" 1 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${TODAY}\",\"failedStreak\":${quota_streak}}" \
  "3 consecutive failed runs"

echo "==> existing staleness behaviour is untouched"
run_case "stale observation still FAILS" 1 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${STALE_DAY}\",\"failedStreak\":${no_streak}}" \
  "STALE"

run_case "fresh observation + no streak passes" 0 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${TODAY}\",\"failedStreak\":${no_streak}}" \
  "price-freshness: ok"

echo "==> threshold override"
run_case "PRICE_FAILED_RUNS=2 trips a 2-run streak" 1 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${TODAY}\",\"failedStreak\":${short_streak}}" \
  "2 consecutive failed runs" \
  PRICE_FAILED_RUNS=2

run_case "PRICE_FAILED_RUNS=5 tolerates a 3-run streak" 0 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${TODAY}\",\"failedStreak\":${quota_streak}}" \
  "price-freshness: ok" \
  PRICE_FAILED_RUNS=5

echo "==> an uninterpretable response must fail, never disarm"
run_case "missing failedStreak FAILS" 1 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${TODAY}\"}" \
  "no failedStreak object"

run_case "renamed field (failedStreak as a string) FAILS" 1 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${TODAY}\",\"failedStreak\":\"none\"}" \
  "no failedStreak object"

run_case "non-numeric failedStreak.count FAILS" 1 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${TODAY}\",\"failedStreak\":{\"count\":\"three\",\"threshold\":3}}" \
  "failedStreak.count is not a number"

run_case "non-numeric threshold FAILS" 1 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${TODAY}\",\"failedStreak\":{\"count\":0,\"threshold\":\"three\"}}" \
  "failedStreak.threshold is not a number"

run_case "a non-numeric PRICE_FAILED_RUNS FAILS" 1 \
  "{\"observationCount\":42,\"latestObservedDate\":\"${TODAY}\",\"failedStreak\":${no_streak}}" \
  "cannot interpret the failed-run threshold" \
  PRICE_FAILED_RUNS=lots

run_case "transport failure FAILS" nonzero \
  "{}" \
  "" \
  SHIM_CURL_FAIL=1

echo "==> the deliberate no-op exits"
run_case "unset secret skips" 0 \
  "{\"observationCount\":0,\"latestObservedDate\":null,\"failedStreak\":${quota_streak}}" \
  "HAQITA_INGEST_SECRET not set" \
  HAQITA_INGEST_SECRET=

echo
if [ "$failures" -gt 0 ]; then
  printf 'price-freshness test: %d case(s) failed\n' "$failures" >&2
  exit 1
fi
echo "price-freshness test: all cases passed"
