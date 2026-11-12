#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# RumaQ local test automation runner
# ============================================================
# Builds and runs the full Docker test suite locally:
#   - API via Miniflare (real D1/R2)
#   - Web via nginx (production Vite build, built at container start)
#   - Reverse proxy published on an ephemeral loopback port
#   - API integration tests (Vitest + fetch)
#   - E2E smoke test (Playwright)
#
# Usage:
#   ./automation/scripts/test-local.sh              # run everything
#   ./automation/scripts/test-local.sh --build      # force rebuild images for this toolchain
#   ./automation/scripts/test-local.sh --no-build   # never build; fail fast if images are missing
#   ./automation/scripts/test-local.sh --down       # tear down every stack from this checkout (by label)
#   ./automation/scripts/test-local.sh --clean      # --down + this toolchain's build-cache volume
#   ./automation/scripts/test-local.sh --api        # run API tests only (needs stack)
#   ./automation/scripts/test-local.sh --e2e        # run E2E tests only (needs stack)
#
# Images are toolchain-only (#356): they carry bun/node/nginx/Playwright and the
# installed dependency tree, never repo source. Source is bind-mounted read-only
# and each service builds its artifact at container start, content-hash cached.
# Image tags are a digest of the toolchain inputs, so:
#   - a source edit needs no image work at all;
#   - a deps/config edit builds one new tag (compose builds a missing image);
#   - every checkout with the same lockfile shares one tag.
#
# Every invocation gets its own Compose project and an ephemeral, loopback-only
# host port discovered after `up` (#356, superseding the #511 per-checkout
# identity). Containers carry a rumaq.automation.checkout label, and --down
# sweeps by that label, so a parallel run from the same checkout is never
# adopted, recreated, or torn down.
#   COMPOSE_PROJECT_NAME  explicit project name (validated, still wins)
#   RUMAQ_TEST_PORT       explicit loopback host port instead of an ephemeral one
#   RUMAQ_READY_TIMEOUT   readiness budget in seconds (default 180)
#   RUMAQ_BUILD_CACHE     set 0 to bypass the content-hash build cache
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
LIB_FILE="$ROOT_DIR/automation/scripts/lib/stack.sh"
MODE="${1:-run}"
# Strip leading -- for convenience (--build → build)
MODE="${MODE#--}"
BUILD_MODE="if-needed"
TEAR_DOWN=""
READY_TIMEOUT="${RUMAQ_READY_TIMEOUT:-180}"

# shellcheck source=lib/stack.sh
source "$LIB_FILE"

# Parse flags. Only the first positional arg is the mode.
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

if [[ ! "$READY_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  fail "RUMAQ_READY_TIMEOUT must be a positive integer number of seconds (got '$READY_TIMEOUT')."
  exit 1
fi

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
# Per-invocation identity (#356)
# ------------------------------------------------------------------
# The compose project used to be derived from the checkout path (#511), which
# made two runs from the SAME checkout share a project, a network and a port —
# the second `up` recreated the first run's proxy and whichever exited first
# tore the other down. Project identity is now per invocation; the checkout
# path is a label, used only by --down to sweep this checkout's runs.
# COMPOSE_PROJECT_NAME (the Compose-standard override) still wins when set.
RUN_ID="$(stack_run_id)"
if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
  if [[ ! "${COMPOSE_PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    fail "COMPOSE_PROJECT_NAME must start with a lowercase letter or digit and use only lowercase letters, digits, '-' or '_' (got '${COMPOSE_PROJECT_NAME}')."
    exit 1
  fi
  PROJECT_NAME="$COMPOSE_PROJECT_NAME"
else
  PROJECT_NAME="$(stack_project_name "$ROOT_DIR" "$RUN_ID")"
fi

# Every compose call goes through here: the explicit file keeps build contexts
# stable, and -p pins this invocation's project — it also overrides any
# COMPOSE_PROJECT_NAME a `.env` next to the compose file might set.
compose() {
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" "$@"
}

# Identity and toolchain digest are exported for Compose interpolation and for
# the container entrypoints' build cache. The digest changes when — and only
# when — a baked toolchain input changes.
export RUMAQ_CHECKOUT_PATH="$ROOT_DIR"
export RUMAQ_RUN_ID="$RUN_ID"
if ! RUMAQ_DEPS_DIGEST="$(stack_deps_digest "$ROOT_DIR")"; then
  fail "Could not compute the toolchain digest."
  exit 1
fi
export RUMAQ_DEPS_DIGEST

IMAGE_API="rumaq-test-api:${RUMAQ_DEPS_DIGEST}"
IMAGE_WEB="rumaq-test-web:${RUMAQ_DEPS_DIGEST}"
IMAGE_RUNNER="rumaq-test-runner:${RUMAQ_DEPS_DIGEST}"
CACHE_VOLUME="rumaq-test-cache-${RUMAQ_DEPS_DIGEST}"

IMAGE_TAGS=("$IMAGE_API" "$IMAGE_WEB" "$IMAGE_RUNNER")

# ------------------------------------------------------------------
# Source preflight
# ------------------------------------------------------------------
# Docker creates a missing bind-mount source as a root-owned empty directory
# (for a file target it can even fail at container start). Check every mounted
# path up front so a typo or a sparse checkout names the path instead of
# leaving repo pollution behind.
PREFLIGHT_PATHS=(
  'backend/src'
  'backend/migrations'
  'contract/src'
  'automation/tests'
  'automation/playwright.config.js'
  'frontend/src'
  'frontend/public'
)

preflight_mounts() {
  local rel
  local -a missing=()
  for rel in "${PREFLIGHT_PATHS[@]}"; do
    [[ -e "$ROOT_DIR/$rel" ]] || missing+=("$rel")
  done
  if ((${#missing[@]} > 0)); then
    fail "Missing path(s) the Docker stack bind-mounts read-only: ${missing[*]}"
    info "Restore them before running the suite (Docker would create them as directories)."
    exit 1
  fi
}

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
# Compose records the compose file that created each container. The project name
# is per-invocation now, but an explicit COMPOSE_PROJECT_NAME can still point two
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

# ------------------------------------------------------------------
# Diagnostics (uploaded by the Scheduled Test Automation workflow)
# ------------------------------------------------------------------
PROBE_ATTEMPTS=""
READY_PHASE=""
READY_URL=""
READY_STATUS=""
READY_BODY=""
READY_ELAPSED=0

write_diagnostics() {
  local dir="$ROOT_DIR/automation/test-results/diagnostics/$RUN_ID" cid svc
  mkdir -p "$dir"
  {
    printf 'project: %s\n' "$PROJECT_NAME"
    printf 'proxy: %s\n' "${TEST_PORT:-unknown}"
    printf 'toolchain digest: %s\n' "$RUMAQ_DEPS_DIGEST"
    printf '\n== compose ps ==\n'
    compose ps -a 2>&1 || true
    printf '\n== container state ==\n'
    compose ps -a -q 2> /dev/null | while read -r cid; do
      [[ -n "$cid" ]] || continue
      docker inspect -f '{{.Name}} status={{.State.Status}} exit={{.State.ExitCode}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$cid" 2>&1 || true
    done
  } > "$dir/ps.txt" 2>&1 || true
  {
    printf 'phase: %s\n' "${READY_PHASE:-none}"
    printf 'url: %s\n' "${READY_URL:-none}"
    printf 'status: %s\n' "${READY_STATUS:-none}"
    printf 'elapsed: %ss (budget %ss)\n' "$READY_ELAPSED" "$READY_TIMEOUT"
    printf 'body: %s\n' "${READY_BODY:-none}"
    printf '\n== attempts ==\n'
    if [[ -n "$PROBE_ATTEMPTS" && -f "$PROBE_ATTEMPTS" ]]; then
      cat "$PROBE_ATTEMPTS"
    fi
  } > "$dir/probe.txt" 2>&1 || true
  for svc in api web proxy; do
    compose logs --no-color --tail=200 "$svc" > "$dir/logs-$svc.txt" 2>&1 || true
  done
  rm -f "${PROBE_ATTEMPTS:-}"
  info "Diagnostics: automation/test-results/diagnostics/$RUN_ID"
  info "Readiness budget: RUMAQ_READY_TIMEOUT=${READY_TIMEOUT}s (raise it on a cold machine)."
}

diagnose_and_fail() {
  fail "$1"
  write_diagnostics
  exit 1
}

# ------------------------------------------------------------------
# Readiness gate (#356 + the #318 canary)
# ------------------------------------------------------------------
# Compose healthchecks only order containers; they cannot see the published
# path. This gate is the contract: /api/health must answer 200 *and* {"ok":true}
# (a static route), the SPA root must answer 200 with id="root" (proves nginx is
# serving the runtime-built bundle), then the #318 canary must answer 401
# (proves the harness's dispatch/auth path survived its cold start). One
# deadline covers all three phases; every attempt is logged with status, elapsed
# time and a body snippet, and a failure leaves a diagnostics bundle behind.
probe_until_ready() {
  local phase="$1" method="$2" url="$3" body_file attempt=0 code body snippet class ms remaining
  body_file="$(mktemp)"
  while :; do
    if ((SECONDS >= READY_DEADLINE)); then
      READY_ELAPSED=$((SECONDS - READY_STARTED))
      break
    fi
    attempt=$((attempt + 1))
    code="$(stack_http_code "$method" "$url" "$body_file")"
    code="${code:-000}"
    # Classify the whole body (the SPA's id="root" sits past the first 200
    # chars); only the log/diagnostics excerpt is truncated.
    body="$(cat "$body_file" 2> /dev/null || true)"
    snippet="$(printf '%s' "$body" | head -c 200 | tr '\n\r' '  ' || true)"
    READY_PHASE="$phase"
    READY_URL="$url"
    READY_STATUS="$code"
    READY_BODY="$snippet"
    READY_ELAPSED=$((SECONDS - READY_STARTED))
    class="$(stack_classify_probe "$phase" "$code" "$body")"
    printf '%-6s attempt %-2d status %-3s elapsed %ss body: %s\n' \
      "$phase" "$attempt" "$code" "$READY_ELAPSED" "${snippet:-<empty>}" >> "$PROBE_ATTEMPTS"
    case "$class" in
      ready)
        ok "$phase ready: HTTP $code after ${READY_ELAPSED}s"
        rm -f "$body_file"
        return 0
        ;;
      fatal)
        fail "$phase fatal: HTTP $code ${snippet:-<empty>}"
        rm -f "$body_file"
        return 2
        ;;
      *)
        fail "$phase attempt $attempt: HTTP $code ${snippet:-<empty>} (${READY_ELAPSED}s elapsed, budget ${READY_TIMEOUT}s)"
        ;;
    esac
    ms="$(stack_backoff_ms "$attempt")"
    # +/-20% jitter so concurrent runs do not poll in lockstep.
    ms=$(((ms * (80 + RANDOM % 41)) / 100))
    remaining=$((READY_DEADLINE - SECONDS))
    ((remaining > 0)) || break
    if ((ms > remaining * 1000)); then
      ms=$((remaining * 1000))
    fi
    sleep "$(printf '%d.%03d' $((ms / 1000)) $((ms % 1000)))"
  done
  rm -f "$body_file"
  return 1
}

wait_ready() {
  local rc=0
  READY_STARTED=$SECONDS
  READY_DEADLINE=$((READY_STARTED + READY_TIMEOUT))
  PROBE_ATTEMPTS="$(mktemp)"

  probe_until_ready health GET "http://127.0.0.1:${TEST_PORT}/api/health" || rc=$?
  if ((rc == 2)); then
    diagnose_and_fail "Health route /api/health returned 404 — the route was renamed or removed."
  elif ((rc != 0)); then
    diagnose_and_fail "The stack did not answer GET /api/health within ${READY_TIMEOUT}s."
  fi

  rc=0
  probe_until_ready spa GET "http://127.0.0.1:${TEST_PORT}/" || rc=$?
  if ((rc == 2)); then
    diagnose_and_fail "The SPA root returned 404 — nginx is not serving the built app."
  elif ((rc != 0)); then
    diagnose_and_fail "The SPA root did not become ready within ${READY_TIMEOUT}s (web build or nginx not up)."
  fi

  rc=0
  probe_until_ready canary POST "http://127.0.0.1:${TEST_PORT}/api/purchases" || rc=$?
  if ((rc == 2)); then
    diagnose_and_fail "Canary route /api/purchases returned 404 — the route was renamed or removed; update wait_ready() in $0."
  elif ((rc != 0)); then
    diagnose_and_fail "First unauthenticated request kept failing within ${READY_TIMEOUT}s; the harness cold start did not settle (see #318)."
  fi

  rm -f "$PROBE_ATTEMPTS"
  PROBE_ATTEMPTS=""
}

# ------------------------------------------------------------------
# Ports (#356)
# ------------------------------------------------------------------
# The default is an ephemeral, loopback-only publish (127.0.0.1::3000):
# Docker picks a free port, so there is no scan and no check-then-bind race.
# RUMAQ_TEST_PORT pins an explicit loopback port (validated early, as before);
# RUMAQ_PROXY_PORTS can override the whole mapping.
configure_port() {
  if [[ -z "${RUMAQ_TEST_PORT:-}" ]]; then
    return 0
  fi
  if [[ ! "${RUMAQ_TEST_PORT}" =~ ^[0-9]+$ ]] || ((RUMAQ_TEST_PORT < 1 || RUMAQ_TEST_PORT > 65535)); then
    fail "RUMAQ_TEST_PORT must be an integer between 1 and 65535 (got '${RUMAQ_TEST_PORT}')."
    exit 1
  fi
  if ! stack_port_free "$RUMAQ_TEST_PORT"; then
    fail "RUMAQ_TEST_PORT=$RUMAQ_TEST_PORT is already in use; pick another port."
    exit 1
  fi
  export RUMAQ_PROXY_PORTS="127.0.0.1:${RUMAQ_TEST_PORT}:3000"
}

# Read the port Docker assigned from `docker compose port`. The mapping is
# available as soon as the container exists; poll briefly to absorb the compose
# bookkeeping gap, then fail loudly rather than guessing.
discover_port() {
  local line port i
  for i in $(seq 1 20); do
    line="$(compose port proxy 3000 2> /dev/null | head -n1 || true)"
    if port="$(stack_parse_published_port "$line")"; then
      TEST_PORT="$port"
      return 0
    fi
    sleep 0.1
  done
  diagnose_and_fail "Could not discover the published proxy port ('docker compose port proxy 3000' returned '${line:-<empty>}')."
}

# ------------------------------------------------------------------
# Build policy and stack lifecycle
# ------------------------------------------------------------------
image_missing() {
  ! docker image inspect "$1" > /dev/null 2>&1
}

apply_build_policy() {
  local tag missing=()
  case "$BUILD_MODE" in
    force)
      info "Rebuilding toolchain images for digest ${RUMAQ_DEPS_DIGEST}..."
      compose build
      ;;
    never)
      for tag in "${IMAGE_TAGS[@]}"; do
        image_missing "$tag" && missing+=("$tag")
      done
      if ((${#missing[@]} > 0)); then
        fail "--no-build: image(s) missing for toolchain digest ${RUMAQ_DEPS_DIGEST}:"
        printf '       %s\n' "${missing[@]}"
        info "Drop --no-build (compose builds a missing tag) or pass --build to rebuild this digest."
        exit 1
      fi
      ;;
    *)
      # Nothing to do: compose builds a missing tag during `up`/`run`. A tag
      # that exists was built from this exact toolchain digest, so there is no
      # staleness class left to cover with an explicit build.
      ;;
  esac
}

ensure_stack() {
  local owners

  preflight_mounts
  configure_port

  # Refuse to stomp a project owned by another checkout: `up -d` would adopt it
  # and later teardown would kill that run. Only reachable through an explicit
  # COMPOSE_PROJECT_NAME now, kept as defence in depth.
  if owners="$(foreign_project_owner)"; then
    fail "Compose project '$PROJECT_NAME' is already running from another checkout: ${owners//$'\n'/, }"
    info "Refusing to reuse or tear it down. Finish that run, or stop it from"
    info "that checkout with: COMPOSE_PROJECT_NAME='$PROJECT_NAME' ./scripts/test.sh automation-local --down"
    exit 1
  fi

  apply_build_policy

  # The cache volume is external (so `down --volumes` can never delete a cache
  # another run is using); compose requires it to exist before `up`.
  if ! docker volume inspect "$CACHE_VOLUME" > /dev/null 2>&1; then
    docker volume create "$CACHE_VOLUME" > /dev/null
  fi

  # From here this run owns the stack; cleanup() tears it down on every exit.
  TEAR_DOWN="1"

  info "Compose project: $PROJECT_NAME"
  info "Toolchain digest: $RUMAQ_DEPS_DIGEST (images rumaq-test-*:${RUMAQ_DEPS_DIGEST})"
  if ! compose up -d api web proxy; then
    diagnose_and_fail "docker compose up failed (a dependency did not become healthy)."
  fi

  discover_port
  info "Proxy: http://127.0.0.1:$TEST_PORT (in-network: http://proxy:3000)"
  wait_ready
  ok "Stack ready in ${SECONDS}s (project $PROJECT_NAME, port $TEST_PORT)."
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
# Teardown by label (--down / --clean)
# ------------------------------------------------------------------
# No name or port needs to be remembered: find every container labelled with
# this checkout, map it to its project, verify the project was created by this
# checkout's compose file, then tear that project down. Killed runs and
# COMPOSE_PROJECT_NAME overrides are covered; another checkout never is.
sweep_checkout_stacks() {
  local project found=0
  while read -r project; do
    [[ -n "$project" ]] || continue
    found=1
    info "Tearing down compose project '$project' (checkout label sweep)..."
    docker compose -f "$COMPOSE_FILE" -p "$project" down --volumes --remove-orphans \
      || fail "Teardown of project '$project' failed."
  done < <(stack_sweep_projects "$ROOT_DIR" "$COMPOSE_FILE")
  if ((found == 0)); then
    ok "No automation stack for this checkout."
  fi
}

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
    info "Building toolchain images for digest '$RUMAQ_DEPS_DIGEST'..."
    compose build
    ok "Images built. Run ./automation/scripts/test-local.sh to start tests."
    ;;

  down)
    sweep_checkout_stacks
    ;;

  clean)
    sweep_checkout_stacks
    if docker volume inspect "$CACHE_VOLUME" > /dev/null 2>&1; then
      docker volume rm "$CACHE_VOLUME" > /dev/null \
        && ok "Removed build-cache volume '$CACHE_VOLUME' (this toolchain digest only)."
    else
      ok "No build-cache volume for this toolchain digest."
    fi
    info "Superseded image tags are not removed automatically; prune them manually (docs/TEST_STRATEGY.md)."
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
    echo "Usage: $0 [--build|--no-build|--down|--clean|--api|--e2e]"
    echo ""
    echo "  (no flag)       Full Docker test suite; build only missing toolchain images"
    echo "  --build         Force rebuild of this toolchain digest's images"
    echo "  --no-build      Never build; fail fast if this digest's images are missing"
    echo "  --down          Tear down every stack started from this checkout (by label)"
    echo "  --clean         --down plus this toolchain's content-hash cache volume"
    echo "  --api           API integration tests only"
    echo "  --e2e           E2E tests only"
    echo ""
    echo "Each invocation uses its own compose project and an ephemeral loopback"
    echo "host port, discovered after 'up' (#356). Environment overrides:"
    echo "  COMPOSE_PROJECT_NAME=<name>   explicit project name"
    echo "  RUMAQ_TEST_PORT=<port>        explicit loopback port"
    echo "  RUMAQ_READY_TIMEOUT=<seconds> readiness budget (default 180)"
    echo "  RUMAQ_BUILD_CACHE=0           bypass the content-hash build cache"
    echo "  RUMAQ_PROXY_PORTS=<mapping>   full compose port mapping override"
    exit 1
    ;;
esac
