#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# RumaQ local test automation runner
# ============================================================
# Builds and runs the full Docker test suite locally:
#   - API via Miniflare (real D1/R2)
#   - Web via nginx (production Vite build)
#   - Reverse proxy on localhost:3000
#   - API integration tests (Vitest + fetch)
#   - E2E smoke test (Playwright)
#
# Usage:
#   ./automation/scripts/test-local.sh              # run everything, build if needed
#   ./automation/scripts/test-local.sh --build      # force rebuild images before running
#   ./automation/scripts/test-local.sh --no-build   # never rebuild; fail if images missing
#   ./automation/scripts/test-local.sh --down         # tear down containers
#   ./automation/scripts/test-local.sh --api          # run API tests only (needs stack)
#   ./automation/scripts/test-local.sh --e2e          # run E2E tests only (needs stack)
#
# The runner keeps containers up between runs by default so iteration is fast.
# Use --down when you are done, or when you want a completely clean state.
#
# Prerequisites:
#   - Docker + Docker Compose
# ============================================================

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/automation/docker-compose.yml"
MODE="${1:-run}"
# Strip leading -- for convenience (--build → build)
MODE="${MODE#--}"
BUILD_MODE="if-needed"
TEAR_DOWN=""

# Parse flags. Only the first positional arg is the mode; everything else is
# forwarded to the test command.
if [[ "$MODE" == "build" ]]; then
  BUILD_MODE="force"
  MODE="run"
elif [[ "$MODE" == "no-build" ]]; then
  BUILD_MODE="never"
  MODE="run"
fi

require_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "Error: $1 is not installed. $2"
    exit 1
  fi
}

info() { echo -e "==> $1"; }
ok() { echo -e "  ✓  $1"; }
fail() { echo -e "  ✗  $1"; }

install_docker() {
  info "Docker not found. Attempting auto-install..."
  if command -v curl &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
  elif command -v wget &> /dev/null; then
    wget -qO- https://get.docker.com | sh
  elif command -v apt &> /dev/null; then
    sudo apt update && sudo apt install -y docker.io docker-compose-v2
  elif command -v dnf &> /dev/null; then
    sudo dnf install -y docker docker-compose
  elif command -v yum &> /dev/null; then
    sudo yum install -y docker docker-compose-plugin
  elif command -v pacman &> /dev/null; then
    sudo pacman -S --noconfirm docker docker-compose
  elif command -v zypper &> /dev/null; then
    sudo zypper install -y docker docker-compose
  elif command -v apk &> /dev/null; then
    sudo apk add docker docker-compose
  else
    fail "Could not auto-install Docker. Install manually: https://docs.docker.com/get-docker/"
    exit 1
  fi
  sudo systemctl enable --now docker 2> /dev/null || sudo rc-update add docker boot 2> /dev/null || true
  if ! groups "$USER" 2> /dev/null | grep -q docker; then
    sudo usermod -aG docker "$USER"
    info "Added $USER to docker group. Log out and back in, or run 'newgrp docker'."
  fi
  ok "Docker installed."
}

if ! command -v docker &> /dev/null; then
  install_docker
fi

# ------------------------------------------------------------------
# Check Docker group membership (permission fix)
# ------------------------------------------------------------------
if ! docker info &> /dev/null; then
  docker_err="$(docker info 2>&1)"
  if echo "$docker_err" | grep -qi "permission denied" 2> /dev/null; then
    info "Adding $USER to the docker group..."
    sudo usermod -aG docker "$USER"
    ok "User added to docker group. Log out and back in, or run 'newgrp docker'."
    info "After re-login, re-run this script."
    exit 0
  fi
fi

cd "$ROOT_DIR"

# ------------------------------------------------------------------
# Check Docker is running
# ------------------------------------------------------------------
if ! docker info &> /dev/null; then
  info "Docker is not running. Attempting to start it..."
  if command -v systemctl &> /dev/null; then
    sudo systemctl start docker
  elif command -v service &> /dev/null; then
    sudo service docker start
  elif command -v rc-service &> /dev/null; then
    sudo rc-service docker start
  else
    fail "Could not start Docker automatically. Start Docker manually and try again."
    exit 1
  fi
  # Wait for Docker to be ready
  for i in $(seq 1 10); do
    if docker info &> /dev/null; then
      ok "Docker is now running."
      break
    fi
    sleep 1
  done
  if ! docker info &> /dev/null; then
    fail "Docker still not running after 10s. Check 'sudo journalctl -u docker' for errors."
    exit 1
  fi
fi

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
# Shared failure epilogue for stack start-up problems: dump logs, tear the
# stack down, and fail the run loudly before any suite executes.
stack_failure() {
  fail "$1"
  docker compose -f "$COMPOSE_FILE" logs proxy api
  docker compose -f "$COMPOSE_FILE" down --volumes
  exit 1
}

# Issue #318: the first unauthenticated request after the stack starts can hit
# a transient dispatch error in the local worker harness (Miniflare/workerd
# warm-up) and return 500 where the API answers 401. The worker-side 401 path
# never touches D1, so /api/health alone does not exercise it. Probe the exact
# signature and retry briefly; a persistent non-401 fails the run before the
# suites start, dumping the response body for diagnosis.
# This gate bounds only the stack-start window: both #318 occurrences struck at
# a later test file's first request, after earlier files had already passed, so
# a mid-suite one-off dispatch error is out of this canary's reach. On such a
# recurrence the suite still fails, but expectStatus() now surfaces the 500's
# body (automation/tests/local/api/steps/helpers.js).
canary_first_request() {
  local body i code
  body="$(mktemp)"
  for i in 1 2 3 4 5; do
    code="$(curl -s -o "$body" -w '%{http_code}' -X POST http://localhost:3000/api/purchases || true)"
    if [[ "$code" == "401" ]]; then
      if [[ "$i" -gt 1 ]]; then
        ok "Canary recovered after cold start (attempt $i): unauthenticated POST /api/purchases -> 401."
      else
        ok "Canary: unauthenticated POST /api/purchases -> 401."
      fi
      rm -f "$body"
      return 0
    fi
    # A 404 right after /api/health served 200 cannot be transient: routes
    # register at bundle load, so the canary route must have been renamed or
    # removed. Retry cannot help; point at the canary instead of cold start.
    if [[ "$code" == "404" ]]; then
      local snippet
      snippet="$(head -c 300 "$body")"
      rm -f "$body"
      stack_failure "Canary route /api/purchases returned 404 - the route was renamed or removed; update canary_first_request() in $0. Body: $snippet"
    fi
    fail "Canary attempt $i: unauthenticated POST /api/purchases -> ${code:-no-response} (expected 401). Body: $(head -c 300 "$body")"
    sleep 1
  done
  rm -f "$body"
  stack_failure "First unauthenticated request keeps failing; harness cold start did not settle."
}

ensure_stack() {
  local build_flag=""
  if [[ "$BUILD_MODE" == "force" ]]; then
    # `up --build` only covers services started by `up`; the test-runner runs
    # via `compose run`, so rebuild it explicitly.
    docker compose -f "$COMPOSE_FILE" build test-runner
    build_flag="--build"
  elif [[ "$BUILD_MODE" == "never" ]]; then
    build_flag=""
  else
    # If images already exist, skip build for speed. Docker compose will still
    # build missing images automatically.
    build_flag=""
  fi

  info "Ensuring test stack is running..."
  if [[ -n "$build_flag" ]]; then
    docker compose -f "$COMPOSE_FILE" up -d --build api web proxy
  else
    docker compose -f "$COMPOSE_FILE" up -d api web proxy
  fi

  info "Waiting for http://localhost:3000/api/health to be ready..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
      ok "API is ready."
      canary_first_request
      return 0
    fi
    sleep 1
  done

  stack_failure "API did not become ready. Check the proxy and api logs."
}

cleanup() {
  if [[ -n "$TEAR_DOWN" ]]; then
    info "Tearing down test containers..."
    docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans
  fi
}

# ------------------------------------------------------------------
# Dispatch
# ------------------------------------------------------------------
case "$MODE" in
  run)
    info "Running full test suite (API integration + E2E) via Docker..."
    ensure_stack

    docker compose -f "$COMPOSE_FILE" run --rm test-runner
    EXIT_CODE=$?

    TEAR_DOWN="1" cleanup

    # Generate HTML report from vitest JSON (mounted volume)
    if [ -f "$ROOT_DIR/automation/test-results/vitest/api-results.json" ]; then
      node "$ROOT_DIR/automation/scripts/generate-test-report.js" 2> /dev/null \
        && ok "HTML report: automation/test-results/test-report.html" || true
    fi

    if [[ $EXIT_CODE -eq 0 ]]; then
      echo ""
      ok "All tests passed!"
    else
      echo ""
      fail "Tests failed (exit code $EXIT_CODE)."
      info "Check test-results/ for details."
    fi
    exit $EXIT_CODE
    ;;

  build)
    info "Building Docker images..."
    docker compose -f "$COMPOSE_FILE" build
    ok "Images built. Run ./automation/scripts/test-local.sh to start tests."
    ;;

  down)
    info "Tearing down test containers..."
    docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans
    ok "Containers removed."
    ;;

  api)
    info "Running API integration tests..."
    ensure_stack

    docker compose -f "$COMPOSE_FILE" run --rm test-runner \
      sh -c "bunx vp test --project integration && sync"
    EXIT_CODE=$?
    TEAR_DOWN="1" cleanup
    exit $EXIT_CODE
    ;;

  e2e)
    info "Running E2E tests..."
    ensure_stack

    docker compose -f "$COMPOSE_FILE" run --rm test-runner \
      sh -c "bun x playwright test --config automation/playwright.config.js && sync"
    EXIT_CODE=$?
    TEAR_DOWN="1" cleanup
    exit $EXIT_CODE
    ;;

  *)
    echo "Usage: $0 [--build|--no-build|--down|--api|--e2e]"
    echo ""
    echo "  (no flag)       Full Docker test suite; reuse existing images/containers"
    echo "  --build         Force rebuild images before running"
    echo "  --no-build      Never build; fail if images are missing"
    echo "  --down          Tear down containers"
    echo "  --api           API integration tests only"
    echo "  --e2e           E2E tests only"
    exit 1
    ;;
esac
