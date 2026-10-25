#!/usr/bin/env bash
# Single-shot scraper pipeline for the systemd timer + manual use
# (docs/plan/haqita-integration.md §6 scripts/run.sh).
#
# Usage:
#   ./scraper/scripts/run.sh                 # dry-run (payload written to state dir)
#   ./scraper/scripts/run.sh --publish       # POST to RUMAQ_INGEST_URL
#
# Environment (see docs/ARCHITECTURE.md §Secrets):
#   GEMINI_API_KEY           required for OCR
#   RUMAQ_INGEST_URL         required with --publish
#   RUMAQ_INGEST_SECRET      required with --publish
#   RUMAQ_SCRAPER_STATE_DIR  defaults to ./state (/var/lib/rumaq-scraper on the VPS)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

exec bun "$ROOT_DIR/scraper/src/main.ts" "$@"
