#!/usr/bin/env bash
# D1 -> R2 backup export (ahaqqu/RumaQ#342, docs/plan/d1-backup.md §5-§6).
#
# Exports the production D1 database via the REST API (polling contract),
# downloads the dump from the one-hour signed URL, uploads it into the
# PRIVATE receipts bucket under backups/<db>/<WIB-date>/dump.sql, and prunes
# retention (14 daily + 4 weekly-Sunday slots). Retention runs only on the
# success path — a failed backup never deletes the previous dumps.
#
# Credentials come from the environment (the caller decides where values
# live — GitHub secrets, .env, or an interactive shell; this script never
# reads .env itself):
#   CLOUDFLARE_ACCOUNT_ID        required
#   CLOUDFLARE_DATABASE_ID       required (production D1 UUID)
#   CLOUDFLARE_API_TOKEN         required unless BACKUP_CLOUDFLARE_API_TOKEN is set
#   BACKUP_CLOUDFLARE_API_TOKEN  optional scoped override, preferred when set (§9 Option B)
#   D1_DATABASE_NAME             optional, default "rumaq" (keyspace naming)
#   R2_BUCKET_NAME               optional, default "rumaq-receipts" (upload target)
#   EXPORT_POLL_ATTEMPTS         optional, default 60 (10 s apart = 10 min bounded;
#                                an un-polled export auto-cancels server-side)
#
# Security invariants (§9): the dump exists only in a private temp file
# (deleted on exit); it is never printed, never becomes an Actions artifact,
# and never leaves the Cloudflare perimeter except to this caller; the signed
# URL is fetched WITHOUT the API token so the credential never reaches the R2
# host. The dump is also never imported into production by this script.
#
# bash + curl + jq + GNU date only.
set -euo pipefail

API_ROOT="https://api.cloudflare.com/client/v4"
ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:?export-d1: CLOUDFLARE_ACCOUNT_ID is required}
DB_ID=${CLOUDFLARE_DATABASE_ID:?export-d1: CLOUDFLARE_DATABASE_ID is required}
TOKEN=${BACKUP_CLOUDFLARE_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}
DB_NAME=${D1_DATABASE_NAME:-rumaq}
BUCKET=${R2_BUCKET_NAME:-rumaq-receipts}
POLL_ATTEMPTS=${EXPORT_POLL_ATTEMPTS:-60}
POLL_INTERVAL=${EXPORT_POLL_INTERVAL:-10}
KEEP_DAILY=14
KEEP_WEEKLY=4

log() { echo "==> [backup] $*"; }
die() {
  echo "==> [backup] ERROR: $*" >&2
  exit 1
}

for cmd in curl jq date; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done

if [[ -z $TOKEN ]]; then
  die "no API token — set CLOUDFLARE_API_TOKEN (or a scoped BACKUP_CLOUDFLARE_API_TOKEN, docs/plan/d1-backup.md §9 Option B)"
fi

api_ok() { # body -> API-level success envelope check
  jq -e '.success == true' >/dev/null 2>&1 <<<"$1"
}

api_errors() { # body -> human-readable error string
  jq -r '[.errors[]? | .message] + [.result.error? // empty] | join("; ") // "unknown API error"' <<<"$1" |
    head -c 500
}

DUMP_FILE=$(mktemp "${TMPDIR:-/tmp}/d1-dump.XXXXXX")
chmod 600 "$DUMP_FILE"
trap 'rm -f "$DUMP_FILE"' EXIT

# R2 object keys with slashes are sent literally in the path (NOT %2F) per
# the R2 REST API contract; the keyspace is fixed by this script.
WIB_DATE=$(TZ='Asia/Jakarta' date +%F)
KEY="backups/${DB_NAME}/${WIB_DATE}/dump.sql"

# ------------------------------------------------------------------
# 0. Size trail (§5: growth that makes daily exports disruptive must be
#    visible before it hurts; the workflow log is the searchable record).
# ------------------------------------------------------------------
db_info=$(curl -sS -H "Authorization: Bearer ${TOKEN}" \
  "$API_ROOT/accounts/$ACCOUNT_ID/d1/database/$DB_ID") ||
  die "D1 metadata request failed (check CLOUDFLARE_ACCOUNT_ID/DATABASE_ID)"
if ! api_ok "$db_info"; then
  die "D1 metadata rejected: $(api_errors "$db_info") (check token grants: D1 Edit)"
fi
log "database ${DB_NAME} size on disk: $(jq -r '.result.file_size // "unknown"' <<<"$db_info") bytes"

# ------------------------------------------------------------------
# 1. Export via the polling contract: POST, then re-POST with
#    current_bookmark until status == complete (or bounded give-up).
# ------------------------------------------------------------------
log "exporting D1 database ${DB_NAME} (${DB_ID}) as compatibility=d1 dump"
resp=$(curl -sS -X POST -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  -d '{"output_format":"polling","dump_options":{"compatibility":"d1"}}' \
  "$API_ROOT/accounts/$ACCOUNT_ID/d1/database/$DB_ID/export") ||
  die "export request failed (network)"
if ! api_ok "$resp"; then
  die "export rejected: $(api_errors "$resp") (check token grants: D1 Edit)"
fi

status=$(jq -r '.result.status // "exporting"' <<<"$resp")
bookmark=$(jq -r '.result.at_bookmark // empty' <<<"$resp")
attempt=1
while [[ $status != complete ]]; do
  if [[ $status == error ]]; then
    die "export failed server-side: $(api_errors "$resp")"
  fi
  if (( attempt > POLL_ATTEMPTS )); then
    die "export did not complete after ${POLL_ATTEMPTS} polls x ${POLL_INTERVAL}s — aborting (an un-polled export auto-cancels server-side, so nothing is left dangling)"
  fi
  sleep "$POLL_INTERVAL"
  attempt=$((attempt + 1))
  resp=$(curl -sS -X POST -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
    -d "{\"output_format\":\"polling\",\"current_bookmark\":\"${bookmark}\"}" \
    "$API_ROOT/accounts/$ACCOUNT_ID/d1/database/$DB_ID/export") ||
    die "export poll request failed (network)"
  if ! api_ok "$resp"; then
    die "export poll rejected: $(api_errors "$resp")"
  fi
  status=$(jq -r '.result.status // empty' <<<"$resp")
  next_bookmark=$(jq -r '.result.at_bookmark // empty' <<<"$resp")
  if [[ -n $next_bookmark ]]; then
    bookmark=$next_bookmark
  fi
done

signed_url=$(jq -r '.result.result.signed_url // empty' <<<"$resp")
if [[ -z $signed_url ]]; then
  die "export completed but returned no signed_url"
fi

# ------------------------------------------------------------------
# 2. Download the dump (no Authorization header here on purpose: the signed
#    URL is the only credential the R2 host may see).
# ------------------------------------------------------------------
curl -sS -f "$signed_url" -o "$DUMP_FILE" || die "dump download from the signed URL failed"
if (( $(wc -c <"$DUMP_FILE") == 0 )); then
  die "downloaded dump is empty — refusing to upload"
fi
log "dump downloaded: $(wc -c <"$DUMP_FILE") bytes (not printed, not stored anywhere else)"

# ------------------------------------------------------------------
# 3. Upload into the private bucket under the backups/ keyspace that no
#    Worker binding can address (§9).
# ------------------------------------------------------------------
log "uploading to r2://${BUCKET}/${KEY}"
put_resp=$(curl -sS -f -X PUT -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/octet-stream' --data-binary "@$DUMP_FILE" \
  "$API_ROOT/accounts/$ACCOUNT_ID/r2/buckets/$BUCKET/objects/$KEY") ||
  die "R2 upload failed (check token grants: Workers R2 Storage Edit)"
log "uploaded ${KEY} ($(jq -r '.size // "unknown"' <<<"$put_resp") bytes, etag $(jq -r '.etag // "unknown"' <<<"$put_resp"))"

# ------------------------------------------------------------------
# 4. Retention prune — success-only path (§6): list backups/<db>/, keep the
#    newest 14 daily (non-Sunday) and 4 weekly (Sunday) dates, delete the
#    rest. One dump object per date key, so date order IS recency order.
# ------------------------------------------------------------------
log "pruning retention (keep ${KEEP_DAILY} daily, ${KEEP_WEEKLY} weekly-Sunday)"
PREFIX="backups/${DB_NAME}/"
keys=()
dates=()
cursor=""
while :; do
  list_url="$API_ROOT/accounts/$ACCOUNT_ID/r2/buckets/$BUCKET/objects?per_page=1000&prefix=${PREFIX}"
  if [[ -n $cursor ]]; then
    list_url+="&cursor=${cursor}"
  fi
  list_resp=$(curl -sS -H "Authorization: Bearer ${TOKEN}" "$list_url") ||
    die "R2 object listing failed"
  if ! api_ok "$list_resp"; then
    die "R2 object listing rejected: $(api_errors "$list_resp")"
  fi
  while IFS=$'\t' read -r object_key; do
    if [[ $object_key =~ ^backups/${DB_NAME}/([0-9]{4}-[0-9]{2}-[0-9]{2})/dump\.sql$ ]]; then
      keys+=("$object_key")
      dates+=("${BASH_REMATCH[1]}")
    fi
  done < <(jq -r '.result[].key' <<<"$list_resp")
  if [[ $(jq -r '.result_info.is_truncated // false' <<<"$list_resp") != true ]]; then
    break
  fi
  cursor=$(jq -r '.result_info.cursor // empty' <<<"$list_resp")
  if [[ -z $cursor ]]; then
    die "listing truncated but no cursor returned"
  fi
done

total=${#keys[@]}
log "found ${total} backup object(s) under ${PREFIX}"
if (( total == 0 )); then
  die "no backup objects found after upload — listing came back empty"
fi

kept=0
deleted=0
daily_seen=0
weekly_seen=0
while IFS=$'\t' read -r date_str; do
  weekday=$(date -d "$date_str" +%u) # 1=Mon ... 7=Sun
  keep=false
  if [[ $weekday == 7 ]]; then
    if (( weekly_seen < KEEP_WEEKLY )); then
      keep=true
    fi
    weekly_seen=$((weekly_seen + 1))
  else
    if (( daily_seen < KEEP_DAILY )); then
      keep=true
    fi
    daily_seen=$((daily_seen + 1))
  fi
  for i in "${!dates[@]}"; do
    if [[ ${dates[$i]} == "$date_str" ]]; then
      if [[ $keep == true ]]; then
        kept=$((kept + 1))
      else
        curl -sS -f -X DELETE -H "Authorization: Bearer ${TOKEN}" \
          "$API_ROOT/accounts/$ACCOUNT_ID/r2/buckets/$BUCKET/objects/${keys[$i]}" >/dev/null ||
          die "retention delete failed for ${keys[$i]}"
        deleted=$((deleted + 1))
        log "pruned ${keys[$i]}"
      fi
    fi
  done
done < <(printf '%s\n' "${dates[@]}" | sort -ur)

log "retention: kept ${kept}, deleted ${deleted} (policy: ${KEEP_DAILY} daily + ${KEEP_WEEKLY} weekly)"
log "backup complete: r2://${BUCKET}/${KEY}"
