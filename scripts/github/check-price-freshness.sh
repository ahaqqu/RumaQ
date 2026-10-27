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
# Two deliberate no-op exits so the check only alerts once it can
# mean something:
#   - HAQITA_INGEST_SECRET unset → the GitHub secret is not
#     configured yet (post-merge, pre-go-live window).
#   - zero observations → the first live ingest has not happened yet.
# Everything else that cannot be interpreted — a missing/renamed field,
# an inconsistent shape, transport or auth failure — fails the step: the
# alert must never be silently disarmed.
#
# Env:
#   HAQITA_INGEST_SECRET  bearer secret (same value the box uses)
#   RUMAQ_PROD_URL        default https://rumaq.ahaqqu.com
#   PRICE_STALE_HOURS     default 168 (7 days) — the service-down threshold.
#                         A single failed nightly run is NOT down: the scraper
#                         logs it, reports it to the run monitor, and the timer
#                         retries the next night (the systemd unit stays green).
#                         Only 7 consecutive failed nights — a week of no data
#                         — means the pipeline is actually broken.
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

latest_ts="$(date -ud "${latest}T00:00:00Z" +%s)"
now_ts="$(date -u +%s)"
age_hours=$(( (now_ts - latest_ts) / 3600 ))

if [ "$age_hours" -ge "$MAX_AGE_HOURS" ]; then
  echo "price-freshness: STALE — latest observation is ${latest} (${age_hours}h old, max ${MAX_AGE_HOURS}h)" >&2
  exit 1
fi

echo "price-freshness: ok — latest observation ${latest} (${age_hours}h old)"
