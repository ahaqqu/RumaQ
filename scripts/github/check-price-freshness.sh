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
#
# Env:
#   HAQITA_INGEST_SECRET  bearer secret (same value the box uses)
#   RUMAQ_PROD_URL        default https://rumaq.ahaqqu.com
#   PRICE_STALE_HOURS     default 26 — tolerates one missed nightly run
# ============================================================

BASE_URL="${RUMAQ_PROD_URL:-https://rumaq.ahaqqu.com}"
MAX_AGE_HOURS="${PRICE_STALE_HOURS:-26}"

if [ -z "${HAQITA_INGEST_SECRET:-}" ]; then
  echo "price-freshness: HAQITA_INGEST_SECRET not set — skipping (set the GitHub secret to arm the staleness alert)"
  exit 0
fi

status="$(curl -fsS --max-time 30 \
  -H "Authorization: Bearer ${HAQITA_INGEST_SECRET}" \
  "${BASE_URL}/api/internal/prices/status")"

count="$(printf '%s' "$status" | jq -r '.observationCount // 0')"
latest="$(printf '%s' "$status" | jq -r '.latestObservedDate // empty')"

if [ "$count" -eq 0 ] || [ -z "$latest" ]; then
  echo "price-freshness: no observations yet — skipping (go-live pending)"
  exit 0
fi

latest_ts="$(date -ud "${latest}T00:00:00Z" +%s)"
now_ts="$(date -u +%s)"
age_hours=$(( (now_ts - latest_ts) / 3600 ))

if [ "$age_hours" -ge "$MAX_AGE_HOURS" ]; then
  echo "price-freshness: STALE — latest observation is ${latest} (${age_hours}h old, max ${MAX_AGE_HOURS}h)" >&2
  exit 1
fi

echo "price-freshness: ok — latest observation ${latest} (${age_hours}h old)"
