#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# RumaQ local test automation runner
# ============================================================
# Builds and runs the full Docker test suite locally:
#   - API via Miniflare (real D1/R2)
#   - Web via nginx (production Vite build)
#   - Reverse proxy published on a per-run host port
#   - API integration tests (Vitest + fetch)
#   - E2E smoke test (Playwright)
#
# Usage:
#   ./automation/scripts/test-local.sh              # run everything, build if needed
#   ./automation/scripts/test-local.sh --build      # force rebuild images before running
#   ./automation/scripts/test-local.sh --no-build   # never rebuild; fail if images missing
#   ./automation/scripts/test-local.sh --down         # tear down this checkout's containers
#   ./automation/scripts/test-local.sh --api          # run API tests only (needs stack)
#   ./automation/scripts/test-local.sh --e2e          # run E2E tests only (needs stack)
#
# Every run is isolated (#511): the Compose project name is derived from this
# checkout's path and the proxy's host port is chosen as a free port, so
# parallel worktrees/sessions never share containers, networks, or ports.
#   COMPOSE_PROJECT_NAME  explicit project name (repeat it for --down)
#   RUMAQ_TEST_PORT       explicit host port (repeat it for --down)
#
# The runner tears the stack down whenever it exits - green, red, or interrupted
# (#506). A project whose containers were created by a different compose file
# is never reused or torn down: the ownership guard aborts the run instead.
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
# Per-run identity (#511)
# ------------------------------------------------------------------
# Compose normally derives the project name from the compose file's directory -
# `automation` in every checkout - so two worktrees share one project, one
# network, and the published host port: concurrent runs kill each other. Derive
# the project name from this checkout's absolute path instead:
#   - deterministic: a re-run and `--down` in the same checkout address the
#     same project without a state file;
#   - collision-safe: the basename names the worktree, and the path checksum
#     separates same-named checkouts.
# COMPOSE_PROJECT_NAME (the Compose-standard override) wins when set.
sanitize_compose_name() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9_-]/-/g' -e 's/^[^a-z0-9]*//' -e 's/-\{2,\}/-/g' -e 's/-*$//'
}

CHECKOUT_HASH="$(printf '%s' "$ROOT_DIR" | cksum | cut -d' ' -f1)"

derive_project_name() {
  local base
  base="$(sanitize_compose_name "$(basename "$ROOT_DIR")")"
  # Docker network names are DNS labels; 24 chars of basename plus the prefix
  # and hash stays well below the 63-character limit.
  base="${base:0:24}"
  base="${base%-}"
  [[ -n "$base" ]] || base="checkout"
  printf 'automation-%s-%08x\n' "$base" "$CHECKOUT_HASH"
}

if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
  if [[ ! "${COMPOSE_PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    fail "COMPOSE_PROJECT_NAME must start with a lowercase letter or digit and use only lowercase letters, digits, '-' or '_' (got '${COMPOSE_PROJECT_NAME}')."
    exit 1
  fi
  PROJECT_NAME="$COMPOSE_PROJECT_NAME"
else
  PROJECT_NAME="$(derive_project_name)"
fi

# Every compose call goes through here: the explicit file keeps build contexts
# stable, and -p pins the per-run project - it also overrides any
# COMPOSE_PROJECT_NAME a `.env` next to the compose file might set.
compose() {
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" "$@"
}

# True when something already listens on 127.0.0.1:$1. A refused TCP connect
# means the port is free; bash's /dev/tcp keeps this dependency-free (no
# nc/lsof/python).
port_in_use() {
  (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null
}

# Pick the host port the proxy publishes. RUMAQ_TEST_PORT wins; otherwise start
# at a path-derived offset and scan for a free port, so concurrent runs from the
# same checkout land on different ports instead of racing for one. The 3100-3899
# band stays clear of the legacy shared port 3000. Errors go to stderr: the
# caller captures stdout as the port number.
choose_test_port() {
  local offset i candidate
  if [[ -n "${RUMAQ_TEST_PORT:-}" ]]; then
    if [[ ! "${RUMAQ_TEST_PORT}" =~ ^[0-9]+$ ]] || ((RUMAQ_TEST_PORT < 1 || RUMAQ_TEST_PORT > 65535)); then
      fail "RUMAQ_TEST_PORT must be an integer between 1 and 65535 (got '${RUMAQ_TEST_PORT}')." >&2
      return 1
    fi
    if port_in_use "$RUMAQ_TEST_PORT"; then
      fail "RUMAQ_TEST_PORT=$RUMAQ_TEST_PORT is already in use; pick another port." >&2
      return 1
    fi
    printf '%s\n' "$RUMAQ_TEST_PORT"
    return 0
  fi
  offset=$((CHECKOUT_HASH % 800))
  for i in $(seq 0 799); do
    candidate=$((3100 + (offset + i) % 800))
    if ! port_in_use "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  fail "No free host port in 3100-3899; set RUMAQ_TEST_PORT explicitly." >&2
  return 1
}

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
# Compose records the compose file that created each container. The project name
# is per-checkout now, but an explicit COMPOSE_PROJECT_NAME can still point two
# checkouts at one project, so that label stays the ownership check: a stack
# under our project whose compose file is not ours belongs to another checkout,
# and neither ensure_stack nor cleanup may touch it.
running_stack_owners() {
  local cid
  compose ps -q 2> /dev/null | while read -r cid; do
    [[ -n "$cid" ]] || continue
    docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$cid" 2> /dev/null || true
  done | sed '/^$/d' | sort -u || true
}

# Print the foreign compose file path(s) when our project name is owned by
# another checkout, and return non-zero when the project is ours (or empty).
foreign_project_owner() {
  local owners
  owners="$(running_stack_owners)"
  [[ -n "$owners" && "$owners" != "$COMPOSE_FILE" ]] || return 1
  printf '%s\n' "$owners"
}

# Shared failure epilogue for stack start-up problems: dump logs and fail the
# run loudly before any suite executes. The EXIT trap does the teardown.
stack_failure() {
  fail "$1"
  compose logs proxy api || true
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
    code="$(curl -s -o "$body" -w '%{http_code}' -X POST "http://localhost:$TEST_PORT/api/purchases" || true)"
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
  local build_flag="" owners

  # One free host port per run; exported so Compose's ${RUMAQ_TEST_PORT}
  # interpolation publishes the proxy there for every call in this process.
  TEST_PORT="$(choose_test_port)" || exit 1
  export RUMAQ_TEST_PORT="$TEST_PORT"

  # Refuse to stomp a project owned by another checkout: `up -d` would adopt it
  # and later teardown would kill that run.
  if owners="$(foreign_project_owner)"; then
    fail "Compose project '$PROJECT_NAME' is already running from another checkout: ${owners//$'\n'/, }"
    info "Refusing to reuse or tear it down. Finish that run, or stop it from"
    info "that checkout with: COMPOSE_PROJECT_NAME='$PROJECT_NAME' ./scripts/test.sh automation-local --down"
    exit 1
  fi

  if [[ "$BUILD_MODE" == "force" ]]; then
    # `up --build` only covers services started by `up`; the test-runner runs
    # via `compose run`, so rebuild it explicitly.
    compose build test-runner
    build_flag="--build"
  elif [[ "$BUILD_MODE" == "never" ]]; then
    build_flag=""
  else
    # If images already exist, skip build for speed. Docker compose will still
    # build missing images automatically.
    build_flag=""
  fi

  # From here this run owns the stack; cleanup() tears it down on every exit.
  TEAR_DOWN="1"

  info "Compose project: $PROJECT_NAME (proxy: http://localhost:$TEST_PORT)"
  if [[ -n "$build_flag" ]]; then
    compose up -d --build api web proxy
  else
    compose up -d api web proxy
  fi

  info "Waiting for http://localhost:$TEST_PORT/api/health to be ready..."
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:$TEST_PORT/api/health" > /dev/null 2>&1; then
      ok "API is ready."
      canary_first_request
      return 0
    fi
    sleep 1
  done

  stack_failure "API did not become ready. Check the proxy and api logs."
}

cleanup() {
  [[ -n "$TEAR_DOWN" ]] || return 0

  # Re-check ownership at teardown time: an explicit COMPOSE_PROJECT_NAME may
  # have pointed another checkout at this project since ensure_stack ran, and
  # its stack must survive.
  local owners
  if owners="$(foreign_project_owner)"; then
    info "Leaving compose project '$PROJECT_NAME' in place: it belongs to another checkout (${owners//$'\n'/, })."
    return 0
  fi

  info "Tearing down compose project '$PROJECT_NAME'..."
  compose down --volumes --remove-orphans \
    || fail "Teardown failed. Run ./scripts/test.sh automation-local --down from this checkout to clean up."
}

# #506: a failing suite used to exit under `set -e` before the success-path
# teardown ran, leaking the stack. Run cleanup from an EXIT trap so every exit
# path (pass, fail, Ctrl-C, TERM) tears down the stack this run owns.
on_exit() {
  local status=$?
  trap - EXIT
  cleanup
  exit "$status"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ------------------------------------------------------------------
# Dispatch
# ------------------------------------------------------------------
case "$MODE" in
  run)
    info "Running full test suite (API integration + E2E) via Docker..."
    ensure_stack

    EXIT_CODE=0
    compose run --rm test-runner || EXIT_CODE=$?

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
    info "Building Docker images for compose project '$PROJECT_NAME'..."
    compose build
    ok "Images built. Run ./automation/scripts/test-local.sh to start tests."
    ;;

  down)
    # --down honours the same ownership guard as a run: it only ever removes
    # this checkout's project, never a stack created by a foreign compose file.
    if owners="$(foreign_project_owner)"; then
      fail "Compose project '$PROJECT_NAME' is owned by another checkout: ${owners//$'\n'/, }"
      info "Refusing to tear it down. Stop it from that checkout instead."
      exit 1
    fi
    info "Tearing down compose project '$PROJECT_NAME'..."
    compose down --volumes --remove-orphans
    ok "Containers removed."
    ;;

  api)
    info "Running API integration tests..."
    ensure_stack

    EXIT_CODE=0
    compose run --rm test-runner \
      sh -c "bunx vp test --project integration && sync" || EXIT_CODE=$?
    exit $EXIT_CODE
    ;;

  e2e)
    info "Running E2E tests..."
    ensure_stack

    EXIT_CODE=0
    compose run --rm test-runner \
      sh -c "bun x playwright test --config automation/playwright.config.js && sync" || EXIT_CODE=$?
    exit $EXIT_CODE
    ;;

  *)
    echo "Usage: $0 [--build|--no-build|--down|--api|--e2e]"
    echo ""
    echo "  (no flag)       Full Docker test suite; reuse existing images/containers"
    echo "  --build         Force rebuild images before running"
    echo "  --no-build      Never build; fail if images are missing"
    echo "  --down          Tear down this checkout's containers"
    echo "  --api           API integration tests only"
    echo "  --e2e           E2E tests only"
    echo ""
    echo "Each run uses its own compose project and host port (#511)."
    echo "Override with COMPOSE_PROJECT_NAME=<name> RUMAQ_TEST_PORT=<port>"
    echo "(repeat both values for --down)."
    exit 1
    ;;
esac
