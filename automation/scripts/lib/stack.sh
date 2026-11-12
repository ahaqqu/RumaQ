#!/usr/bin/env bash
# shellcheck shell=bash
# ============================================================
# RumaQ automation stack library (ahaqqu/RumaQ#356)
# ============================================================
# Pure functions shared by the stack runner (automation/scripts/test-local.sh)
# and its offline guard (scripts/test/automation-stack.sh). Nothing here runs at
# source time, and nothing here touches the network or the repo — the guard
# sources this file with RUMAQ_STACK_LIB_ONLY=1 and exercises every rule with
# canned inputs and PATH shims, so a broken rule fails in CI instead of on a
# developer's machine.
#
# The rules encoded here are the four load-bearing invariants of the #356
# restructure:
#   1. Image identity is a digest of the toolchain inputs, never the checkout
#      (stack_deps_digest) — so every checkout shares one tag per lockfile and
#      a deps/config edit builds exactly one new tag.
#   2. Project identity is per invocation (stack_project_name, stack_run_id) —
#      so two runs from the same checkout cannot adopt or kill each other.
#   3. Teardown finds work by the checkout label (stack_sweep_projects) — never
#      by guessing a name, and never across checkouts.
#   4. Readiness is classified from what the published port actually answered
#      (stack_classify_probe) with a bounded backoff (stack_backoff_ms).
# ============================================================

# ------------------------------------------------------------------
# Identity
# ------------------------------------------------------------------

# Compose object names are DNS labels: lowercase [a-z0-9_-], and the name must
# not start with '-' or '_'. Same rule the derived project name has used since
# #511 — kept here so a worktree with spaces/punctuation still yields a valid
# project.
stack_sanitize_name() {
  printf '%s' "${1:-}" |
    tr '[:upper:]' '[:lower:]' |
    sed -e 's/[^a-z0-9_-]/-/g' -e 's/^[^a-z0-9]*//' -e 's/-\{2,\}/-/g' -e 's/-*$//'
}

# Checkout hash: cksum of the absolute path. Stable for a checkout, different
# for a sibling worktree with the same basename.
stack_checkout_hash() {
  printf '%s' "${1:-}" | cksum | cut -d' ' -f1
}

# base36 of a non-negative integer (bash arithmetic only — no python/coreutils
# dependency, so this works in the CI image and in a bare container).
stack_base36() {
  local n="${1:-0}" digits='0123456789abcdefghijklmnopqrstuvwxyz' out=''
  if ! [[ "$n" =~ ^[0-9]+$ ]] || ((n < 0)); then
    printf '0'
    return 0
  fi
  if ((n == 0)); then
    printf '0'
    return 0
  fi
  while ((n > 0)); do
    out="${digits:n%36:1}${out}"
    n=$((n / 36))
  done
  printf '%s' "$out"
}

# Per-invocation run id: base36(epoch seconds)-pid. Different processes in the
# same second still differ; a retry of the same process never reuses it.
stack_run_id() {
  printf '%s-%s\n' "$(stack_base36 "$(date +%s)")" "$$"
}

# The pre-#356 project name: automation-<slug24>-<checkout hash8>. Stacks from
# before the per-invocation switch carry no checkout label, so `--down` finds
# them by this deterministic name (and still re-checks every container's
# compose file in stack_sweep_projects). Kept byte-compatible with the old
# derive_project_name so an upgrade can clean up its predecessor.
stack_legacy_project_name() {
  local root="${1:-}" base hash
  base="$(stack_sanitize_name "$(basename "$root")")"
  base="${base:0:24}"
  base="${base%-}"
  [[ -n "$base" ]] || base="checkout"
  hash="$(stack_checkout_hash "$root")"
  printf 'automation-%s-%08x\n' "$base" "$hash"
}

# automation-<slug16>-<checkout_hash8>-<run_id>
#
# The project (not the run id) is what keeps parallel runs apart, so it must be
# unique per invocation while staying inside Docker's 63-char network-name
# limit: `<project>_default` is the network name, hence project <= 55 chars.
# The slug is capped at 16 and the run id at its natural max (base36 seconds
# plus a 7-digit pid), which puts the longest generated name at 53.
stack_project_name() {
  local root="${1:-}" run_id="${2:-}" base hash
  hash="$(stack_checkout_hash "$root")"
  base="$(stack_sanitize_name "$(basename "$root")")"
  base="${base:0:16}"
  base="${base%-}"
  [[ -n "$base" ]] || base="checkout"
  printf 'automation-%s-%08x-%s\n' "$base" "$hash" "$run_id"
}

# ------------------------------------------------------------------
# Toolchain digest (#356: image identity)
# ------------------------------------------------------------------
# Every file baked into an image is hashed; a file that is only bind-mounted is
# not. Keeping this list exhaustive is what makes "a manifest/config edit
# rebuilds, a source edit does not" true instead of aspirational — if a baked
# file is missing here, an edit to it silently reuses a stale image.
#
# Deliberate exception: automation/playwright.config.js is baked only so the
# read-only bind-mount target exists (Docker creates a directory for a missing
# file target) and is always overridden by the live mount, so it is not part of
# the image identity. Its content still keys the test-runner's build cache.
stack_deps_inputs() {
  cat <<'EOF'
automation/docker/Dockerfile.api
automation/docker/Dockerfile.web
automation/docker/Dockerfile.test-runner
automation/docker/entrypoint-api.sh
automation/docker/entrypoint-test-runner.sh
automation/docker/entrypoint-web.sh
automation/docker/build-cache.sh
automation/docker/nginx.web.conf
.dockerignore
bun.lock
package.json
frontend/package.json
backend/package.json
contract/package.json
vite.config.ts
backend/vite.config.ts
backend/cloudflare.config.ts
backend/tsconfig.json
contract/tsconfig.json
frontend/vite.config.js
frontend/index.html
EOF
}

# Print the 12-char toolchain digest for a repository root. Fails loudly (not
# with a partial digest) when an input is missing: a silently shortened hash
# would collide across different toolchains.
stack_deps_digest() {
  local root="${1:-.}" rel
  local -a inputs=() missing=()
  mapfile -t inputs < <(stack_deps_inputs)
  for rel in "${inputs[@]}"; do
    [[ -f "$root/$rel" ]] || missing+=("$rel")
  done
  if ((${#missing[@]} > 0)); then
    printf 'stack: missing toolchain input(s) under %s: %s\n' "$root" "${missing[*]}" >&2
    return 1
  fi
  (cd "$root" && sha256sum "${inputs[@]}") | sha256sum | cut -c1-12
}

# ------------------------------------------------------------------
# Ports (#356: ephemeral, loopback-only publishing)
# ------------------------------------------------------------------

# Parse the output of `docker compose port <service> <port>` into a host port.
# Accepted shapes, all observed on Docker 29 / Compose 5:
#   127.0.0.1:32795   -> 32795   (loopback-only, the default)
#   0.0.0.0:32769     -> 32769
#   [::]:32795        -> 32795
# Multi-line output (IPv4 + IPv6 bindings) uses the first mapping. Empty or
# malformed output fails instead of inventing a port.
stack_parse_published_port() {
  local line="${1:-}" first port
  first="${line%%$'\n'*}"
  first="${first%$'\r'}"
  [[ -n "$first" ]] || return 1
  port="${first##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  ((port >= 1 && port <= 65535)) || return 1
  printf '%s\n' "$port"
}

# True when nothing currently listens on 127.0.0.1:<port>. Only used for the
# explicit RUMAQ_TEST_PORT override: the default path lets Docker assign the
# port, which removes the check-then-bind TOCTOU window entirely.
stack_port_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/${1:-0}") 2>/dev/null
}

# ------------------------------------------------------------------
# Readiness gate (#356 + #318 canary)
# ------------------------------------------------------------------

# Backoff for attempt N (1-based), in milliseconds: 250 ms, 500 ms, 1 s, then a
# 2 s cap. Monotonic by construction; the runner adds +/-20% jitter.
stack_backoff_ms() {
  case "${1:-1}" in
    1) printf '250' ;;
    2) printf '500' ;;
    3) printf '1000' ;;
    *) printf '2000' ;;
  esac
}

# Classify one readiness probe attempt: ready | retry | fatal.
#
#   health  GET /api/health        200 + {"ok":true}  -> ready
#                                  404                 -> fatal (route renamed)
#                                  anything else        -> retry (5xx is the #318 class)
#   spa     GET /                  200 + id="root"     -> ready
#                                  404                 -> fatal (no SPA / wrong route)
#                                  anything else        -> retry (502 while web builds)
#   canary  POST /api/purchases    401                 -> ready (#318 signature)
#                                  404                 -> fatal (canary route renamed)
#                                  anything else        -> retry, body captured
stack_classify_probe() {
  local phase="${1:-}" code="${2:-}" body="${3:-}"
  case "$phase" in
    health)
      if [[ "$code" == '200' ]] && [[ "$body" =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]; then
        printf 'ready'
      elif [[ "$code" == '404' ]]; then
        printf 'fatal'
      else
        printf 'retry'
      fi
      ;;
    spa)
      if [[ "$code" == '200' ]] && [[ "$body" == *'id="root"'* ]]; then
        printf 'ready'
      elif [[ "$code" == '404' ]]; then
        printf 'fatal'
      else
        printf 'retry'
      fi
      ;;
    canary)
      if [[ "$code" == '401' ]]; then
        printf 'ready'
      elif [[ "$code" == '404' ]]; then
        printf 'fatal'
      else
        printf 'retry'
      fi
      ;;
    *)
      printf 'retry'
      ;;
  esac
}

# One HTTP probe: print the status code and write the body to <body-file>.
# A refused connection makes curl print 000, which every classifier treats as
# retry — the stack is simply not listening yet.
#
# <max-time> is capped by the caller to the remaining readiness budget (#356
# review B10): a hung connect must not overshoot the 180 s deadline by curl's
# own 10 s timeout. Defaults to 10 s for standalone probes.
stack_http_code() {
  local method="${1:-GET}" url="${2:-}" body_file="${3:-/dev/null}" max_time="${4:-10}"
  [[ "$max_time" =~ ^[0-9]+$ ]] && ((max_time > 0)) || max_time=1
  if [[ "$method" == 'GET' ]]; then
    curl -sS -o "$body_file" -w '%{http_code}' --max-time "$max_time" "$url" 2>/dev/null || true
  else
    curl -sS -o "$body_file" -w '%{http_code}' --max-time "$max_time" -X "$method" "$url" 2>/dev/null || true
  fi
}

# ------------------------------------------------------------------
# Teardown safety (#356 review A1: never project-wide `down` on a mixed project)
# ------------------------------------------------------------------
# One label of one container. Returns docker's status so a missing container or
# a broken daemon is surfaced instead of being read as an empty label.
stack_container_label() {
  local cid="${1:-}" label="${2:-}"
  docker inspect -f "{{ index .Config.Labels \"$label\" }}" "$cid"
}

# True when every container of <project> belongs to <checkout> and was created
# by <compose-file>.
#
#   0  the project is entirely ours -> project-wide `down` is safe
#   1  at least one container is foreign -> skip the project (never `down`)
#   2  docker failed -> the caller must surface it
#
# A compose project can contain containers from more than one compose file (an
# explicit COMPOSE_PROJECT_NAME, a legacy stack, a manual container). Checking
# only the matching container (the pre-review code) let `down --remove-orphans`
# delete the foreign ones, so this check walks *every* container.
#
# <allow-unlabelled>=1 is only used for the pre-#356 project name: those
# containers predate the checkout label, so an empty label is accepted there —
# the compose-file check still rejects another checkout's stack.
stack_project_owned_by() {
  local project="${1:-}" checkout="${2:-}" compose_file="${3:-}" allow_unlabelled="${4:-0}"
  local ids cid checkout_label config_files
  if ! ids="$(docker ps -a -q --filter "label=com.docker.compose.project=$project")"; then
    printf 'stack: docker ps failed while inspecting project %s\n' "$project" >&2
    return 2
  fi
  [[ -n "$ids" ]] || return 2
  for cid in $ids; do
    if ! checkout_label="$(stack_container_label "$cid" 'rumaq.automation.checkout')"; then
      printf 'stack: docker inspect failed for container %s\n' "$cid" >&2
      return 2
    fi
    if ! config_files="$(stack_container_label "$cid" 'com.docker.compose.project.config_files')"; then
      printf 'stack: docker inspect failed for container %s\n' "$cid" >&2
      return 2
    fi
    [[ "$config_files" == "$compose_file" ]] || return 1
    if [[ "$allow_unlabelled" == '1' ]]; then
      [[ -z "$checkout_label" || "$checkout_label" == "$checkout" ]] || return 1
    else
      [[ "$checkout_label" == "$checkout" ]] || return 1
    fi
  done
  return 0
}

# Print the compose projects that are safe to tear down for <checkout>.
#
#   stdout  owned project names, one per line
#   rc 0    clean
#   rc 1    docker failed (the caller must fail the command)
#   rc 3    at least one project was skipped because it is mixed; the caller
#           must warn and exit non-zero rather than pretend it cleaned up
#
# Candidates come from the checkout label plus the deterministic pre-#356
# project name. Every candidate is then verified container by container.
stack_sweep_projects() {
  local checkout="${1:-}" compose_file="${2:-}" cid project legacy legacy_ids status
  local -a candidates=()
  local skipped=0
  [[ -n "$checkout" ]] || return 0

  if ! legacy_ids="$(docker ps -a -q --filter "label=rumaq.automation.checkout=$checkout")"; then
    printf 'stack: docker ps failed while enumerating checkout %s\n' "$checkout" >&2
    return 1
  fi
  for cid in $legacy_ids; do
    if ! project="$(stack_container_label "$cid" 'com.docker.compose.project')"; then
      printf 'stack: docker inspect failed for container %s\n' "$cid" >&2
      return 1
    fi
    [[ -n "$project" ]] && candidates+=("$project")
  done

  legacy="$(stack_legacy_project_name "$checkout")"
  if ! legacy_ids="$(docker ps -a -q --filter "label=com.docker.compose.project=$legacy")"; then
    printf 'stack: docker ps failed while checking legacy project %s\n' "$legacy" >&2
    return 1
  fi
  if [[ -n "$legacy_ids" ]]; then
    candidates+=("$legacy")
  fi

  [[ ${#candidates[@]} -gt 0 ]] || return 0

  while read -r project; do
    [[ -n "$project" ]] || continue
    status=0
    stack_project_owned_by "$project" "$checkout" "$compose_file" 0 || status=$?
    case "$status" in
      0)
        printf '%s\n' "$project"
        continue
        ;;
      2) return 1 ;;
    esac
    if [[ "$project" == "$legacy" ]]; then
      status=0
      stack_project_owned_by "$project" "$checkout" "$compose_file" 1 || status=$?
      case "$status" in
        0)
          printf '%s\n' "$project"
          continue
          ;;
        2) return 1 ;;
      esac
    fi
    printf 'stack: refusing to tear down project %s: not every container belongs to checkout %s and compose file %s\n' \
      "$project" "$checkout" "$compose_file" >&2
    skipped=1
  done < <(printf '%s\n' "${candidates[@]}" | sort -u)

  ((skipped)) && return 3
  return 0
}
