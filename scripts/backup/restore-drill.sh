#!/usr/bin/env bash
# D1 restore drill — the human entrypoint (ahaqqu/RumaQ#342, runbook in
# docs/plan/d1-backup.md §7-§8).
#
# Restores a D1 dump file into a scratch in-memory SQLite (D1 is SQLite) and
# verifies integrity, foreign keys, and the production canary tables BEFORE
# the dump may be imported into production (runbook step 2 is a hard gate).
# Zero secrets, zero network — production untouched.
#
#   ./scripts/backup/restore-drill.sh <dump.sql> [--expect table=count ...]
#
# Default canaries: the six production tables must exist, and a production
# dump must carry at least one user, household and membership — a dump
# missing those is not a usable restore. Pass --expect through for exact
# counts from a known-good state, e.g.:
#   ./scripts/backup/restore-drill.sh dump.sql --expect users=3 --expect stock=142
#
# Cadence: run this against the newest dump in R2 (backups/<db>/<date>/dump.sql)
# as the monthly owner checklist item. Exits non-zero on any failure.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ $# -lt 1 || $1 == -* ]]; then
  echo "usage: $0 <dump.sql> [--expect table=count ...] [--require-table name ...]" >&2
  exit 1
fi

DUMP=$1
shift

echo "== D1 restore drill =="
echo "Restoring '$DUMP' into scratch in-memory SQLite (D1 is SQLite) — production untouched."

exec node "$ROOT_DIR/scripts/backup/verify-dump.mjs" "$DUMP" \
  --require-table users \
  --require-table households \
  --require-table household_members \
  --require-table stock \
  --require-table purchases \
  --require-table documents \
  --expect 'users>=1' \
  --expect 'households>=1' \
  --expect 'household_members>=1' \
  "$@"
