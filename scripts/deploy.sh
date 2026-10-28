#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# RumaQ deploy – local dev setup & Cloudflare deployment
# ============================================================
# Idempotent: run from a clean checkout (first time) or to
# update an existing local / Cloudflare deployment.
#
# Usage:
#   ./scripts/deploy.sh                       # prepare local env + start dev servers
#   ./scripts/deploy.sh cloudflare            # deploy (or update) Cloudflare
#   ./scripts/deploy.sh cloudflare --dry-run  # validate without deploying
#   ./scripts/deploy.sh --dry-run             # alias for dry-run validation
#   ./scripts/deploy.sh frontend              # deploy only the frontend
#   ./scripts/deploy.sh vps                   # deploy the scraper to the VPS
#   ./scripts/deploy.sh vps --dry-run         # build+plan the VPS ship only
# ============================================================

DRY_RUN=false
MODE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    local | cloudflare | frontend | dry-run | vps)
      MODE="$arg"
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [local|cloudflare|frontend|dry-run|vps] [--dry-run]"
      exit 1
      ;;
  esac
done

if [[ -z $MODE ]]; then
  if $DRY_RUN; then
    MODE="cloudflare"
  else
    MODE="local"
  fi
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

# Load .env from project root (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, etc.)
if [[ -f $ROOT_DIR/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

DB_NAME="${D1_DATABASE_NAME:-rumaq}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-rumaq-receipts}"

# Local placeholder that keys the local D1 state (mirrors cloudflare.config.ts).
LOCAL_DATABASE_ID="00000000-0000-4000-8000-000000000000"
# The Vite plugin persists local worker state (D1/R2) here; cf CLI local
# commands must target the same directory to see the same data.
LOCAL_STATE_DIR="$BACKEND_DIR/.cloudflare/state"

cd "$ROOT_DIR"

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
require_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "Error: $1 is not installed. $2"
    exit 1
  fi
}

log() { echo -e "==> $1"; }
ok() { echo -e "  ok  $1"; }
warn() { echo -e "  warn $1"; }

# Run a command only when not in dry-run mode.
# Prints a skip message in dry-run mode and returns success.
run_when_live() {
  local description="$1"
  shift
  if $DRY_RUN; then
    ok "Skipping ${description} in dry-run mode."
    return 0
  fi
  "$@"
}

# cf CLI from the repo's devDependencies. Invoked through Node because loading
# cloudflare.config.ts is not supported when cf itself runs on Bun.
cf_cmd() {
  node "$ROOT_DIR/node_modules/cf/bin/cf" "$@"
}

# Detect branch for branch-specific deployments. Exported because
# backend/cloudflare.config.ts (run as a child process by `cf deploy`) derives
# the Worker name from it — an unexported value made branch deploys fall back
# to the production Worker name.
export BRANCH_NAME="${BRANCH_NAME:-$(git rev-parse --abbrev-ref HEAD 2> /dev/null || echo 'main')}"
SANITIZED_BRANCH=$(echo "$BRANCH_NAME" | sed 's/[^a-zA-Z0-9-]/-/g')

if [[ "$BRANCH_NAME" == "main" || "$BRANCH_NAME" == "master" || "$BRANCH_NAME" == "HEAD" ]]; then
  WORKER_NAME="${WORKER_NAME:-api}"
  WORKER_URL="${WORKER_URL:-https://rumaq.ahaqqu.com}"
else
  WORKER_NAME="${WORKER_NAME:-rumaq-api-${SANITIZED_BRANCH}}"
  WORKER_URL="${WORKER_URL:-https://${WORKER_NAME}.rumaq.workers.dev}"
  log "Branch: ${BRANCH_NAME} -> Worker: ${WORKER_NAME}"
fi

# ------------------------------------------------------------------
# Prerequisites
# ------------------------------------------------------------------
check_prereqs() {
  require_cmd node "Install Node.js (https://nodejs.org)."
  require_cmd bun "Install Bun (https://bun.sh)."
  if [[ ! -x "$ROOT_DIR/node_modules/cf/bin/cf" ]]; then
    echo "Error: cf CLI not found. Run 'bun install' to install devDependencies."
    exit 1
  fi
}

# ------------------------------------------------------------------
# .dev.vars – create from example for local dev if missing
# ------------------------------------------------------------------
ensure_dev_vars() {
  if [[ -f $BACKEND_DIR/.dev.vars ]]; then
    return
  fi

  if [[ ! -f $BACKEND_DIR/.dev.vars.example ]]; then
    echo "Error: backend/.dev.vars.example not found."
    exit 1
  fi

  log "backend/.dev.vars not found – copying from example."
  cp "$BACKEND_DIR/.dev.vars.example" "$BACKEND_DIR/.dev.vars"
  warn "backend/.dev.vars created with placeholder values."
  warn "Edit backend/.dev.vars with real secrets before running the dev server."
}

# ------------------------------------------------------------------
# Dependencies
# ------------------------------------------------------------------
install_deps() {
  log "Installing workspace dependencies..."
  bun install --frozen-lockfile
}

# ------------------------------------------------------------------
# Database – local (via cf CLI local simulation)
# ------------------------------------------------------------------
setup_database_local() {
  log "Setting up local D1 database (${DB_NAME})..."

  cd "$BACKEND_DIR"
  cf_cmd d1 migrations apply "$LOCAL_DATABASE_ID" \
    --local \
    --dir migrations \
    --persist-to "$LOCAL_STATE_DIR"
  cd "$ROOT_DIR"

  ok "Local database ready."
}

# ------------------------------------------------------------------
# Database – remote (Cloudflare D1)
# ------------------------------------------------------------------
# Print the UUID of an existing D1 database by name, or nothing when absent.
find_d1_database() {
  local name=$1
  cf_cmd d1 list 2>/dev/null | node -e '
    let raw = ""
    process.stdin.on("data", (c) => (raw += c))
    process.stdin.on("end", () => {
      // cf prints either a bare JSON array or an object wrapper, possibly
      // with log noise around it — slice from the first bracket to the last.
      const start = raw.search(/[\[{]/)
      const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"))
      if (start === -1 || end === -1 || end <= start) process.exit(0)
      let parsed
      try {
        parsed = JSON.parse(raw.slice(start, end + 1))
      } catch {
        process.exit(0)
      }
      const dbs = Array.isArray(parsed) ? parsed : (parsed.result ?? [])
      const db = dbs.find((d) => d.name === process.argv[1])
      if (db?.uuid) console.log(db.uuid)
    })
  ' "$name"
}

setup_database_remote() {
  log "Setting up remote D1 database (${DB_NAME})..."

  local db_id="${CLOUDFLARE_DATABASE_ID:-}"

  if [[ $db_id == "YOUR_DATABASE_ID" ]]; then
    db_id=""
  fi

  if [[ -z $db_id ]]; then
    db_id=$(find_d1_database "$DB_NAME")
  fi

  if [[ -z $db_id ]]; then
    local create_output
    if ! create_output=$(run_when_live "D1 database create" cf_cmd d1 create --name "$DB_NAME"); then
      if grep -qi 'already exists' <<<"$create_output"; then
        ok "D1 database ${DB_NAME} already exists — reusing it."
      else
        echo "$create_output"
        exit 1
      fi
    fi
    db_id=$(find_d1_database "$DB_NAME")
  fi

  if [[ -z $db_id ]]; then
    warn "Could not determine database_id."
    warn "Set CLOUDFLARE_DATABASE_ID in your environment or .env."
    exit 1
  fi

  # Make the discovered ID available to the rest of the deploy pipeline
  # (especially cloudflare.config.ts when cf deploy evaluates it).
  CLOUDFLARE_DATABASE_ID="$db_id"
  export CLOUDFLARE_DATABASE_ID

  run_when_live "remote D1 migration" \
    cf_cmd d1 migrations apply "$db_id" --dir backend/migrations
}

# ------------------------------------------------------------------
# R2 bucket – create if missing
# ------------------------------------------------------------------
ensure_r2_bucket() {
  local bucket_name="${R2_BUCKET_NAME:-rumaq-receipts}"

  run_when_live "R2 bucket check" bash -c "
    if node '$ROOT_DIR/node_modules/cf/bin/cf' r2 buckets list 2>/dev/null | grep -q '\"$bucket_name\"'; then
      echo '  ok  R2 bucket \"$bucket_name\" already exists.'
    else
      node '$ROOT_DIR/node_modules/cf/bin/cf' r2 buckets create --name '$bucket_name' \
        && echo '  ok  Created R2 bucket \"$bucket_name\".'
    fi
  "
}

# ------------------------------------------------------------------
# Put secrets on the Worker
# ------------------------------------------------------------------
put_worker_secrets() {
  log "Setting Worker secrets for ${WORKER_NAME}..."

  if $DRY_RUN; then
    ok "Skipping secret upload in dry-run mode."
    return
  fi

  local secrets=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET WORKER_JWT_SECRET WORKER_ENCRYPTION_KEY HAQITA_INGEST_SECRET ADMIN_EMAILS)
  for name in "${secrets[@]}"; do
    local val="${!name:-}"
    if [[ -z $val ]]; then
      echo "  -  ${name} (skipped — not set)"
      continue
    fi
    cf_cmd workers secrets update "$name" \
      --worker "$WORKER_NAME" \
      --type secret_text \
      --text "$val"
    echo "  ok  ${name}"
  done

  ok "Worker secrets set."
}

# ------------------------------------------------------------------
# Deploy Worker to Cloudflare
# ------------------------------------------------------------------
deploy_worker() {
  log "Deploying Worker (name: ${WORKER_NAME})..."

  # Worker name, static assets and bindings are computed by
  # backend/cloudflare.config.ts from BRANCH_NAME / CLOUDFLARE_* env vars.
  local dry_run_flag=""
  if $DRY_RUN; then
    dry_run_flag="--dry-run"
  fi

  # The four gateway secrets are declared as secret bindings
  # (cloudflare.config.ts), so they must carry values at deploy time: the CLI
  # refuses to create a Worker whose declared secrets are unset (fresh branch
  # previews), and `workers secrets update` (put_worker_secrets, below) can
  # only run after the first deploy. Supply them via a secrets file.
  local secrets_file=""
  if ! $DRY_RUN; then
    local missing=""
    local secret_name
    for secret_name in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET WORKER_JWT_SECRET WORKER_ENCRYPTION_KEY; do
      if [[ -z ${!secret_name:-} ]]; then
        missing+=" ${secret_name}"
      fi
    done
    if [[ -n $missing ]]; then
      warn "Missing required secret values:${missing}"
      warn "Set them in the environment or .env before deploying."
      exit 1
    fi
    secrets_file="$(mktemp)"
    chmod 600 "$secrets_file"
    for secret_name in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET WORKER_JWT_SECRET WORKER_ENCRYPTION_KEY; do
      printf '%s=%s\n' "$secret_name" "${!secret_name}" >> "$secrets_file"
    done
    dry_run_flag+=" --secrets-file ${secrets_file}"
  fi

  # shellcheck disable=SC2086
  # cf deploy must run next to cloudflare.config.ts so it finds the project.
  local deploy_status=0
  cd "$BACKEND_DIR"
  cf_cmd deploy ${dry_run_flag} || deploy_status=$?
  cd "$ROOT_DIR"
  if [[ -n $secrets_file ]]; then
    rm -f "$secrets_file"
  fi
  if (( deploy_status != 0 )); then
    exit "$deploy_status"
  fi

  if $DRY_RUN; then
    ok "Worker dry-run build succeeded."
  else
    ok "Worker deployed to ${WORKER_URL}."
  fi
}

# ------------------------------------------------------------------
# Build frontend (no deploy)
# ------------------------------------------------------------------
build_frontend() {
  log "Building frontend..."
  bun install --frozen-lockfile
  bunx vp build frontend
  ok "Frontend build succeeded."
}

# ------------------------------------------------------------------
# Check Cloudflare login
# ------------------------------------------------------------------
check_login() {
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    ok "Authenticated via CLOUDFLARE_API_TOKEN."
    return 0
  fi
  if ! cf_cmd d1 list &> /dev/null; then
    echo "Error: not logged in to Cloudflare."
    echo "Set CLOUDFLARE_API_TOKEN or run: cf login"
    exit 1
  fi
  ok "Logged in to Cloudflare."
}

# ------------------------------------------------------------------
# Print summary after local setup
# ------------------------------------------------------------------
summary_local() {
  echo ""
  echo "============================================"
  echo "  Local environment ready!"
  echo "============================================"
  echo ""
  echo "  Start the dev servers:"
  echo "    bunx vp run dev"
  echo ""
  echo "  Make sure backend/.dev.vars has real secrets."
  echo "============================================"
}

# ------------------------------------------------------------------
# Print summary after Cloudflare deploy
# ------------------------------------------------------------------
summary_cloudflare() {
  echo ""
  echo "============================================"
  echo "  Cloudflare deployment complete!"
  echo "============================================"
  echo ""
  echo "  App + API (single Worker): ${WORKER_URL}"
  echo ""
  echo "  Verify health: curl -I ${WORKER_URL}/api/health"
  echo "============================================"
}

# ------------------------------------------------------------------
# Prepare local environment (idempotent)
# ------------------------------------------------------------------
prepare_local() {
  check_prereqs
  ensure_dev_vars
  install_deps
  setup_database_local
  build_frontend
  summary_local
}

# ==================================================================
# MODE: cloudflare
# ==================================================================
do_cloudflare() {
  echo "=== RumaQ: Cloudflare deployment ==="
  check_prereqs
  check_login
  install_deps
  setup_database_remote
  ensure_r2_bucket
  # The frontend build is deployed as Worker static assets, so it must exist
  # before `cf deploy` runs.
  build_frontend
  deploy_worker
  put_worker_secrets
  summary_cloudflare
}

# ==================================================================
# MODE: local – run both servers concurrently
# ==================================================================
do_local() {
  echo "=== RumaQ: local environment ==="
  prepare_local

  cleanup() {
    echo ""
    log "Shutting down dev servers..."
    kill "$FRONTEND_PID" "$BACKEND_PID" 2> /dev/null || true
    wait "$FRONTEND_PID" "$BACKEND_PID" 2> /dev/null || true
  }
  trap cleanup EXIT INT TERM

  log "Starting frontend (Vite) on http://localhost:5173..."
  bunx vp dev frontend &
  FRONTEND_PID=$!

  log "Starting backend (Worker) on http://localhost:8787..."
  bunx vp dev backend &
  BACKEND_PID=$!

  echo ""
  echo "  Frontend: http://localhost:5173"
  echo "  Backend:  http://localhost:8787"
  echo "  Press Ctrl+C to stop both."
  echo ""

  wait "$FRONTEND_PID" "$BACKEND_PID"
}

do_dry_run() {
  DRY_RUN=true
  do_cloudflare
}

# ==================================================================
# Main dispatch
# ==================================================================
case "$MODE" in
  local | "")
    do_local
    ;;
  cloudflare)
    do_cloudflare
    ;;
  dry-run)
    do_dry_run
    ;;
  frontend)
    build_frontend
    if ! $DRY_RUN; then
      deploy_worker
    fi
    ;;
  vps)
    # Ship the scraper bundle to the box (build -> rsync -> browsers ->
    # self-check -> shared-box doctor). Configuration via RUMAQ_VPS_*
    # environment variables; see scripts/deploy/vps.sh.
    bash "$ROOT_DIR/scripts/deploy/vps.sh" $(if $DRY_RUN; then echo --dry-run; fi)
    ;;
  *)
    echo "Unknown mode: $MODE"
    echo "Usage: $0 [local|cloudflare|dry-run|frontend] [--dry-run]"
    exit 1
    ;;
esac

echo ""
echo "=== Done ==="
