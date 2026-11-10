#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# scripts/github/check-price-freshness.sh — price-data staleness
# gate for the 6-hourly smoke workflow (haqita-integration §7.1)
# ============================================================
# Reads GET /api/internal/prices/status on production with the
# scraper's bearer secret and fails when the latest observation is
# older than MAX_AGE_HOURS — the workflow's auto-created smoke-failure
# issue then covers scraping outages end-to-end (box down, timer off,
# scrape error, publish error).
#
# Two branches, because "no new prices" has two shapes:
#   1. STALE — the latest observation is older than MAX_AGE_HOURS
#      (default 7 days). A single failed nightly run is NOT down: the
#      scraper logs it (journal + status.json) and the timer retries the
#      next night (the systemd unit stays green). Only a week of no data at
#      all means the pipeline is broken.
#   2. CONSECUTIVE FAILED RUNS (issue #536) — the runs themselves report
#      failure and published nothing, N times in a row. This branch runs
#      BEFORE the zero-observation skip below, because a pipeline that never
#      publishes has no observation to age out: branch 1 is silently disarmed
#      exactly when the pipeline is dead. The Worker derives the streak from
#      the stored run reports (a run that failed but still published prices is
#      not a failure here — one blocked store is not a dead pipeline) and
#      ships its threshold with the read; PRICE_FAILED_RUNS overrides it.
#
# Deliberate no-op exits so the check only alerts once it can mean something:
#   - HAQITA_INGEST_SECRET unset → the GitHub secret is not configured yet
#     (post-merge, pre-go-live window).
#   - zero observations AND no failed-run streak → the first live ingest has
#     not happened yet.
# Everything else that cannot be interpreted — a missing/renamed field,
# an inconsistent shape, transport or auth failure — fails the step: the
# alert must never be silently disarmed. That includes a Worker that predates
# this branch: the merge→deploy window can therefore trip the probe once (and
# open a smoke-failure issue the workflow closes on the next green pulse),
# which is the price of not treating "no field" as "nothing wrong".
#
# Env:
#   HAQITA_INGEST_SECRET  bearer secret (same value the box uses)
#   RUMAQ_PROD_URL        default https://rumaq.ahaqqu.com
#   PRICE_STALE_HOURS     default 168 (7 days) — the service-down threshold,
#                         measured from the end of the latest observation's
#                         date (branch 1).
#   PRICE_FAILED_RUNS     default: the Worker's failedStreak.threshold
#                         (currently 3) — the consecutive failed-run threshold
#                         (branch 2). The default follows the backend so the
#                         admin banner and this alert cannot disagree about
#                         what "dead" means.
# ============================================================

BASE_URL="${RUMAQ_PROD_URL:-https://rumaq.ahaqqu.com}"
MAX_AGE_HOURS="${PRICE_STALE_HOURS:-168}"

if [ -z "${HAQITA_INGEST_SECRET:-}" ]; then
  echo "price-freshness: HAQITA_INGEST_SECRET not set — skipping (set the GitHub secret to arm the staleness alert)"
  exit 0
fi

status="$(curl -fsS --max-time 30 \
  -H "Authorization: Bearer ${HAQITA_INGEST_SECRET}" \
  "${BASE_URL}/api/internal/prices/status")"

# Shape-check before interpreting: a renamed/missing field must fail loudly,
# never masquerade as an empty table — that would silently disarm this alert.
if ! printf '%s' "$status" | jq -e '.observationCount | numbers' >/dev/null 2>&1; then
  echo "price-freshness: unexpected status response (no numeric observationCount) — failing" >&2
  exit 1
fi

count="$(printf '%s' "$status" | jq -r '.observationCount')"
latest="$(printf '%s' "$status" | jq -r '.latestObservedDate')"

# ---- Branch 2 (issue #536): consecutive failed runs ---------------------
# BEFORE the zero-observation skip: a dead pipeline that never published has
# observationCount 0, which must not read as "go-live pending". Shape-checked
# like every other field — a renamed/absent streak is a disarm, not a zero.
if ! printf '%s' "$status" | jq -e '.failedStreak | objects' >/dev/null 2>&1; then
  echo "price-freshness: unexpected status response (no failedStreak object) — failing" >&2
  exit 1
fi
if ! printf '%s' "$status" | jq -e '.failedStreak.count | numbers' >/dev/null 2>&1; then
  echo "price-freshness: unexpected status response (failedStreak.count is not a number) — failing" >&2
  exit 1
fi
if ! printf '%s' "$status" | jq -e '.failedStreak.threshold | numbers' >/dev/null 2>&1; then
  echo "price-freshness: unexpected status response (failedStreak.threshold is not a number) — failing" >&2
  exit 1
fi

failed_count="$(printf '%s' "$status" | jq -r '.failedStreak.count')"
failed_max="${PRICE_FAILED_RUNS:-$(printf '%s' "$status" | jq -r '.failedStreak.threshold')}"

# An uninterpretable number must fail, never fall through to "ok": inside an
# `if`, a non-numeric `[ -ge ]` is a test error (non-zero), which would read
# as "no streak" and disarm the alert.
case "$failed_count" in
  '' | *[!0-9]*)
    echo "price-freshness: cannot interpret failedStreak.count '${failed_count}' — failing" >&2
    exit 1
    ;;
esac
case "$failed_max" in
  '' | *[!0-9]*)
    echo "price-freshness: cannot interpret the failed-run threshold '${failed_max}' (PRICE_FAILED_RUNS) — failing" >&2
    exit 1
    ;;
esac

if [ "$failed_count" -ge "$failed_max" ]; then
  since="$(printf '%s' "$status" | jq -r '.failedStreak.since // "unknown"')"
  code="$(printf '%s' "$status" | jq -r '.failedStreak.code // "unclassified"')"
  echo "price-freshness: FAILING — ${failed_count} consecutive failed runs (nothing published since ${since}; last failure: ${code}; alert at ${failed_max})" >&2
  exit 1
fi

# Empty table: exactly what the backend returns before the first live ingest.
if [ "$count" -eq 0 ] && [ "$latest" = "null" ]; then
  echo "price-freshness: no observations yet — skipping (go-live pending)"
  exit 0
fi

# Rows without a latest date cannot be assessed for freshness; fail rather
# than skip, so an inconsistent response never hides a real outage.
if [ "$latest" = "null" ]; then
  echo "price-freshness: status response inconsistent (observations without a latest date) — failing" >&2
  exit 1
fi

# latestObservedDate is a date only, and the nightly publish lands late on
# that day (23:00 UTC) — anchor the age at the END of it. Midnight anchoring
# would reach 168h at D+7 00:00 (six failed nights), one night before the
# owner decision's seven; end-of-day is reached at D+8 00:00, after the
# seventh missed run.
latest_ts="$(date -ud "${latest}T23:59:59Z" +%s)"
now_ts="$(date -u +%s)"
age_hours=$(( (now_ts - latest_ts) / 3600 ))

if [ "$age_hours" -ge "$MAX_AGE_HOURS" ]; then
  echo "price-freshness: STALE — latest observation is ${latest} (${age_hours}h old, max ${MAX_AGE_HOURS}h)" >&2
  exit 1
fi

echo "price-freshness: ok — latest observation ${latest} (${age_hours}h old)"
