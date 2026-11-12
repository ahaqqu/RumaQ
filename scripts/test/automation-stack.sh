#!/usr/bin/env bash
set -euo pipefail

# Offline guard for ahaqqu/RumaQ#356 (automation Docker restructure).
#
# The stack runner's identity, digest, port, readiness and teardown rules are
# shell functions in automation/scripts/lib/stack.sh precisely so they can be
# asserted without Docker: this test sources the library and exercises each
# rule with canned inputs, plus PATH shims for the two external commands the
# rules call (curl, docker). It also guards the structural invariants that make
# the restructure true — toolchain-only images and read-only source mounts —
# because a single stray `COPY backend/src` or a missing `:ro` would silently
# reintroduce the staleness class this issue removes.
#
# Offline only: no Docker daemon, no network, no repository mutation.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LIB_FILE="$ROOT_DIR/automation/scripts/lib/stack.sh"
COMPOSE_FILE="$ROOT_DIR/automation/docker-compose.yml"
failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ#356)\n' "$1" >&2
  failures=$((failures + 1))
}

# The library is side-effect free; this flag is the guard's contract that it
# wants the functions only, never the runner.
export RUMAQ_STACK_LIB_ONLY=1
# shellcheck source=../../automation/scripts/lib/stack.sh
source "$LIB_FILE"

# ------------------------------------------------------------------
# 1. Per-invocation project identity
# ------------------------------------------------------------------
echo '==> project identity'

CHECKOUT='/home/ahaqqu/Projects/RumaQ.wt/356-docker'
NAME_A="$(stack_project_name "$CHECKOUT" 'run-a')"
NAME_B="$(stack_project_name "$CHECKOUT" 'run-a')"
NAME_C="$(stack_project_name "$CHECKOUT" 'run-b')"

if [[ "$NAME_A" == "$NAME_B" ]]; then
  pass 'same checkout + run id => same project name'
else
  fail "project name is not deterministic: '$NAME_A' vs '$NAME_B'"
fi

if [[ "$NAME_A" != "$NAME_C" ]]; then
  pass 'different run ids => different project names (per invocation)'
else
  fail "two invocations share project name '$NAME_A'"
fi

if (( ${#NAME_A} <= 55 )); then
  pass "project name stays inside the 55-char network-name headroom (${#NAME_A} chars)"
else
  fail "project name is ${#NAME_A} chars (must be <= 55 for <project>_default)"
fi

if [[ "$NAME_A" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  pass "project name is a valid compose object name ('$NAME_A')"
else
  fail "project name has characters Docker rejects: '$NAME_A'"
fi

LONG_NAME="$(stack_project_name '/tmp/Some Very Long Worktree Name (copy)/x' 'abcdefgh-1234567')"
if (( ${#LONG_NAME} <= 55 )); then
  pass "longest realistic run id still fits (${#LONG_NAME} chars)"
else
  fail "longest realistic run id is ${#LONG_NAME} chars (must be <= 55)"
fi

ODD_NAME="$(stack_project_name '/tmp/My Work.tree! (copy)' 'r1')"
if [[ "$ODD_NAME" == automation-my-work-tree-* && "$ODD_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  pass "odd worktree names are sanitized ('$ODD_NAME')"
else
  fail "odd worktree name produced an invalid project: '$ODD_NAME'"
fi

RUN_ID="$(stack_run_id)"
if [[ "$RUN_ID" =~ ^[0-9a-z]+-[0-9]+$ ]]; then
  pass "run id is base36(seconds)-pid ('$RUN_ID')"
else
  fail "run id has an unexpected shape: '$RUN_ID'"
fi

# The pre-#356 name is what --down falls back to for unlabelled stacks; it must
# stay byte-compatible with the old derive_project_name (slug24 + cksum hash8).
LEGACY_NAME="$(stack_legacy_project_name '/home/ahaqqu/Projects/RumaQ.wt/356-docker')"
if [[ "$LEGACY_NAME" == 'automation-356-docker-f0c9d82a' ]]; then
  pass "legacy project name matches the pre-#356 derivation ('$LEGACY_NAME')"
else
  fail "legacy project name drifted from derive_project_name: '$LEGACY_NAME'"
fi

# ------------------------------------------------------------------
# 2. Published-port parsing
# ------------------------------------------------------------------
echo '==> published port parsing'

expect_port() {
  local name="$1" input="$2" want="${3:-}" got code=0
  got="$(stack_parse_published_port "$input")" || code=$?
  if [[ -n "$want" ]]; then
    if ((code == 0)) && [[ "$got" == "$want" ]]; then
      pass "$name"
    else
      fail "$name (want '$want', got '$got')"
    fi
  else
    if ((code != 0)); then
      pass "$name"
    else
      fail "$name (expected failure, got '$got')"
    fi
  fi
}

expect_port 'loopback mapping parses' '127.0.0.1:32795' 32795
expect_port 'all-interfaces mapping parses' '0.0.0.0:32769' 32769
expect_port 'IPv6 mapping parses' '[::]:32795' 32795
expect_port 'multi-line output uses the first mapping' $'0.0.0.0:32769\n[::]:32795' 32769
expect_port 'empty output fails instead of inventing a port' ''
expect_port 'port 0 is rejected' '127.0.0.1:0'
expect_port 'out-of-range port is rejected' '127.0.0.1:70000'
expect_port 'non-numeric port is rejected' '127.0.0.1:http'

# ------------------------------------------------------------------
# 3. Toolchain digest (image identity)
# ------------------------------------------------------------------
echo '==> toolchain digest'

DIGEST_ROOT="$(mktemp -d)"
SHIM_DIR="$(mktemp -d)"
trap 'rm -rf "$DIGEST_ROOT" "$SHIM_DIR"' EXIT

while read -r rel; do
  mkdir -p "$DIGEST_ROOT/$(dirname "$rel")"
  cp "$ROOT_DIR/$rel" "$DIGEST_ROOT/$rel"
done < <(stack_deps_inputs)

DIGEST_1="$(stack_deps_digest "$DIGEST_ROOT")"
DIGEST_2="$(stack_deps_digest "$DIGEST_ROOT")"

if [[ "$DIGEST_1" == "$DIGEST_2" ]] && [[ "$DIGEST_1" =~ ^[0-9a-f]{12}$ ]]; then
  pass "digest is stable and 12 hex chars ('$DIGEST_1')"
else
  fail "digest is not stable/12-hex: '$DIGEST_1' vs '$DIGEST_2'"
fi

# A source file is NOT an image input: editing it must leave the tag alone.
mkdir -p "$DIGEST_ROOT/backend/src/lib"
printf '// source edit\n' > "$DIGEST_ROOT/backend/src/lib/probe.ts"
if [[ "$(stack_deps_digest "$DIGEST_ROOT")" == "$DIGEST_1" ]]; then
  pass 'source-only change does not move the image digest (no rebuild)'
else
  fail 'a source-only change moved the toolchain digest (would rebuild)'
fi

# A Dockerfile is an image input: editing it must produce a new tag.
printf '\n# probe\n' >> "$DIGEST_ROOT/automation/docker/Dockerfile.api"
DIGEST_DOCKERFILE="$(stack_deps_digest "$DIGEST_ROOT")"
if [[ "$DIGEST_DOCKERFILE" != "$DIGEST_1" ]]; then
  pass 'Dockerfile change moves the digest (new tag built)'
else
  fail 'a Dockerfile change left the toolchain digest unchanged (stale image)'
fi

# A manifest is an image input too: the deps split depends on this.
printf ' ' >> "$DIGEST_ROOT/package.json"
if [[ "$(stack_deps_digest "$DIGEST_ROOT")" != "$DIGEST_DOCKERFILE" ]]; then
  pass 'manifest change moves the digest (new tag built)'
else
  fail 'a manifest change left the toolchain digest unchanged (stale deps)'
fi

# An entrypoint / nginx conf / .dockerignore is baked as well.
printf '# probe\n' >> "$DIGEST_ROOT/automation/docker/nginx.web.conf"
if [[ "$(stack_deps_digest "$DIGEST_ROOT")" != "$DIGEST_DOCKERFILE" ]]; then
  pass 'nginx config change moves the digest'
else
  fail 'an nginx config change left the toolchain digest unchanged'
fi

# Refuse to hash a partial input set.
rm -f "$DIGEST_ROOT/frontend/index.html"
if stack_deps_digest "$DIGEST_ROOT" > /dev/null 2>&1; then
  fail 'a missing toolchain input still produced a digest'
else
  pass 'a missing toolchain input fails instead of producing a partial digest'
fi

# Every file baked by a Dockerfile must be hashed by stack_deps_inputs
# (#356 review B2). A new COPY whose source is not in the digest list would
# silently reuse an image tag across a changed baked file.
copy_sources() {
  local df line token i
  for df in "$ROOT_DIR"/automation/docker/Dockerfile.api \
    "$ROOT_DIR"/automation/docker/Dockerfile.web \
    "$ROOT_DIR"/automation/docker/Dockerfile.test-runner; do
    while IFS= read -r line; do
      [[ "$line" == COPY[[:space:]]* ]] || continue
      local -a tokens=() srcs=()
      read -r -a tokens <<< "$line"
      for ((i = 1; i < ${#tokens[@]}; i++)); do
        token="${tokens[$i]}"
        # COPY --from=<stage>: the source is an earlier build stage, not a repo file.
        [[ "$token" == --from=* ]] && continue 2
        [[ "$token" == --* ]] && continue
        srcs+=("$token")
      done
      # The final non-flag token is the destination.
      ((${#srcs[@]} > 1)) || continue
      for ((i = 0; i < ${#srcs[@]} - 1; i++)); do
        token="${srcs[$i]#./}"
        printf '%s\n' "$token"
      done
    done < "$df"
  done
}

BAKED_SOURCES="$(copy_sources | sort -u)"
DIGEST_INPUTS="$(stack_deps_inputs | sed 's#^\./##' | sort -u)"
UNHASHED=''
while read -r src; do
  [[ -n "$src" ]] || continue
  # Deliberate exception: baked only as a bind-mount target, always overridden
  # by the live file, and the BDD tests are regenerated at container start.
  [[ "$src" == 'automation/playwright.config.js' ]] && continue
  grep -qxF "$src" <<< "$DIGEST_INPUTS" || UNHASHED+="$src"$'\n'
done <<< "$BAKED_SOURCES"

if [[ -n "$BAKED_SOURCES" && -z "$UNHASHED" ]]; then
  pass "every Dockerfile COPY source is part of the toolchain digest ($(wc -l <<< "$BAKED_SOURCES" | tr -d ' ') files)"
else
  fail "Dockerfile bakes file(s) the digest does not hash: $(head -3 <<< "${UNHASHED:-<no COPY sources found>}" | tr '\n' ' ')"
fi

# ------------------------------------------------------------------
# 4. Readiness backoff
# ------------------------------------------------------------------
echo '==> readiness backoff'

PREV=0
MONOTONIC=1
CAPPED=1
for attempt in 1 2 3 4 5 6 7 8; do
  DELAY="$(stack_backoff_ms "$attempt")"
  (( DELAY >= PREV )) || MONOTONIC=0
  (( DELAY <= 2000 )) || CAPPED=0
  PREV="$DELAY"
done
if ((MONOTONIC == 1)); then
  pass 'backoff never decreases'
else
  fail 'backoff is not monotonic'
fi
if ((CAPPED == 1)) && [[ "$(stack_backoff_ms 4)" == '2000' ]]; then
  pass 'backoff caps at 2s'
else
  fail 'backoff does not cap at 2s'
fi
if [[ "$(stack_backoff_ms 1)" == '250' && "$(stack_backoff_ms 2)" == '500' && "$(stack_backoff_ms 3)" == '1000' ]]; then
  pass 'backoff schedule is 250ms -> 500ms -> 1s -> 2s'
else
  fail 'backoff schedule drifted from 250/500/1000/2000'
fi

# ------------------------------------------------------------------
# 5. Probe classification
# ------------------------------------------------------------------
echo '==> probe classification'

expect_class() {
  local name="$1" phase="$2" code="$3" body="$4" want="$5" got
  got="$(stack_classify_probe "$phase" "$code" "$body")"
  if [[ "$got" == "$want" ]]; then
    pass "$name"
  else
    fail "$name (want $want, got $got)"
  fi
}

expect_class 'health 200 + {"ok":true} is ready' health 200 '{"ok":true}' ready
expect_class 'health 200 + spaced {"ok": true} is ready' health 200 '{"ok": true}' ready
expect_class 'health 200 + {"ok":false} retries' health 200 '{"ok":false}' retry
expect_class 'health 500 retries (#318 class)' health 500 '{"error":"boom"}' retry
expect_class 'health connection refused retries' health 000 '' retry
expect_class 'health 404 is fatal (route renamed)' health 404 '' fatal
expect_class 'SPA 200 + id="root" is ready' spa 200 '<div id="root"></div>' ready
expect_class 'SPA 200 without root retries' spa 200 '<html></html>' retry
expect_class 'SPA 502 retries while web builds' spa 502 '' retry
expect_class 'SPA 404 is fatal' spa 404 '' fatal
expect_class 'canary 401 is ready (#318 signature)' canary 401 '' ready
expect_class 'canary 500 retries' canary 500 '{"error":"x"}' retry
expect_class 'canary 404 is fatal (route renamed)' canary 404 '' fatal
expect_class 'canary 200 retries' canary 200 '[]' retry

# ------------------------------------------------------------------
# 6. HTTP probe (curl shim)
# ------------------------------------------------------------------
echo '==> HTTP probe'

cat > "$SHIM_DIR/curl" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CURL_LOG:?}"
body=''
while (($#)); do
  case "$1" in
    -o) body="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$body" ]] && printf '%s' "${CURL_BODY:-}" > "$body"
printf '%s' "${CURL_CODE:-200}"
SHIM
chmod +x "$SHIM_DIR/curl"

export CURL_LOG="$SHIM_DIR/curl.log"
export CURL_CODE=200
export CURL_BODY='{"ok":true}'
PROBE_BODY="$SHIM_DIR/probe.body"

CODE="$(PATH="$SHIM_DIR:$PATH" stack_http_code GET 'http://127.0.0.1:1234/api/health' "$PROBE_BODY")"
if [[ "$CODE" == '200' ]] && [[ "$(cat "$PROBE_BODY")" == '{"ok":true}' ]]; then
  pass 'HTTP probe returns the status code and writes the body'
else
  fail "HTTP probe returned '$CODE' / body '$(cat "$PROBE_BODY" 2> /dev/null)'"
fi
if grep -q 'http://127.0.0.1:1234/api/health' "$CURL_LOG"; then
  pass 'HTTP probe requests the given URL'
else
  fail 'HTTP probe did not request the given URL'
fi

export CURL_CODE=401
: > "$CURL_LOG"
CODE="$(PATH="$SHIM_DIR:$PATH" stack_http_code POST 'http://127.0.0.1:1234/api/purchases' "$PROBE_BODY")"
if [[ "$CODE" == '401' ]] && grep -q -- '-X POST' "$CURL_LOG"; then
  pass 'POST probe keeps the canary method'
else
  fail "POST probe used the wrong method/status ('$CODE')"
fi

# The readiness gate caps each request at the remaining budget (#356 review
# B10), so a hung connect cannot overshoot the deadline by curl's own timeout.
: > "$CURL_LOG"
CODE="$(PATH="$SHIM_DIR:$PATH" stack_http_code GET 'http://127.0.0.1:1234/api/health' "$PROBE_BODY" 3)"
if [[ "$CODE" == '401' ]] && grep -q -- '--max-time 3' "$CURL_LOG"; then
  pass 'HTTP probe honours an explicit max-time (bounded by the readiness budget)'
else
  fail "HTTP probe ignored the max-time argument: $(tr '\n' ' ' < "$CURL_LOG")"
fi
if ! grep -q -- '--max-time 0' "$CURL_LOG"; then
  pass 'max-time is never zero (curl would not treat it as a budget)'
else
  fail 'HTTP probe passed --max-time 0'
fi

# ------------------------------------------------------------------
# 7. Label teardown sweep (docker shim)
# ------------------------------------------------------------------
echo '==> label teardown sweep'

cat > "$SHIM_DIR/docker" <<'SHIM'
#!/usr/bin/env bash
# Minimal docker ps/inspect shim over fixture lines: "cid project config checkout".
if [[ "${DOCKER_FAIL_PS:-0}" == '1' ]]; then
  exit 1
fi
case "${1:-}" in
  ps)
    filter=''
    for arg in "$@"; do
      case "$arg" in
        label=*) filter="${arg#label=}" ;;
      esac
    done
    while read -r cid project config checkout; do
      [[ -n "$cid" ]] || continue
      case "$filter" in
        rumaq.automation.checkout=*)
          [[ "$checkout" == "${filter#rumaq.automation.checkout=}" ]] && printf '%s\n' "$cid"
          ;;
        com.docker.compose.project=*)
          [[ "$project" == "${filter#com.docker.compose.project=}" ]] && printf '%s\n' "$cid"
          ;;
        '')
          printf '%s\n' "$cid"
          ;;
      esac
    done < "${DOCKER_FIXTURE:?}"
    ;;
  inspect)
    [[ "${DOCKER_FAIL_INSPECT:-0}" == '1' ]] && exit 1
    fmt="${3:-}"
    cid="${4:-}"
    while read -r id project config checkout; do
      [[ "$id" == "$cid" ]] || continue
      case "$fmt" in
        *config_files*) printf '%s\n' "$config" ;;
        *com.docker.compose.project*) printf '%s\n' "$project" ;;
        *rumaq.automation.checkout*) printf '%s\n' "$checkout" ;;
      esac
    done < "${DOCKER_FIXTURE:?}"
    ;;
esac
exit 0
SHIM
chmod +x "$SHIM_DIR/docker"

# The pre-#356 project names (unlabelled containers) this checkout's --down
# falls back to.
LEGACY="$(stack_legacy_project_name '/checkout/ours')"

# Fixture A: only this checkout's projects (plus a pure legacy stack). The
# foreign *project* and the other checkout must not even be candidates.
cat > "$SHIM_DIR/fixture-clean" <<FIXTURE
cid-ours-1 automation-ours-1 /compose/ours.yml /checkout/ours
cid-ours-2 automation-ours-1 /compose/ours.yml /checkout/ours
cid-killed automation-ours-2 /compose/ours.yml /checkout/ours
other-1 automation-other /compose/ours.yml /checkout/other
legacy-1 $LEGACY /compose/ours.yml
legacy-2 $LEGACY /compose/ours.yml
FIXTURE

export DOCKER_FIXTURE="$SHIM_DIR/fixture-clean"
RC=0
SWEPT="$(PATH="$SHIM_DIR:$PATH" stack_sweep_projects '/checkout/ours' '/compose/ours.yml')" || RC=$?
EXPECTED_SWEEP="$(printf '%s\n' 'automation-ours-1' 'automation-ours-2' "$LEGACY" | sort)"
GOT_SWEEP="$(sort <<< "$SWEPT")"
if ((RC == 0)) && [[ "$GOT_SWEEP" == "$EXPECTED_SWEEP" ]]; then
  pass 'sweep returns every owned project (deduplicated, killed run and legacy stack included)'
else
  fail "sweep returned '$SWEPT' (rc $RC, expected '$EXPECTED_SWEEP')"
fi
if [[ "$SWEPT" != *automation-other* ]]; then
  pass 'sweep never touches another checkout'
else
  fail 'sweep leaked another checkout project'
fi

# Fixture B (#356 review A1): a project that mixes our container with a foreign
# one must be refused as a whole, never project-wide `down`-ed. Also covers a
# container with our checkout label but a foreign compose file.
cat > "$SHIM_DIR/fixture-mixed" <<'FIXTURE'
cid-ours mixedprobe-1 /compose/ours.yml /checkout/ours
cid-foreign mixedprobe-1 /compose/other.yml /checkout/other
cid-config mixedprobe-2 /compose/ours.yml /checkout/ours
cid-config-foreign mixedprobe-2 /compose/other.yml /checkout/ours
cid-only-foreign mixedprobe-3 /compose/other.yml /checkout/ours
FIXTURE
export DOCKER_FIXTURE="$SHIM_DIR/fixture-mixed"
RC=0
SWEPT="$(PATH="$SHIM_DIR:$PATH" stack_sweep_projects '/checkout/ours' '/compose/ours.yml' 2> "$SHIM_DIR/mixed.err")" || RC=$?
if ((RC == 3)) && [[ -z "$SWEPT" ]]; then
  pass 'a mixed project is refused as a whole (no project-wide down, rc 3)'
else
  fail "mixed project was not refused: rc $RC, stdout '$SWEPT'"
fi
if grep -q 'refusing to tear down project mixedprobe-1' "$SHIM_DIR/mixed.err" &&
  grep -q 'refusing to tear down project mixedprobe-2' "$SHIM_DIR/mixed.err"; then
  pass 'the refusal names the mixed projects (mixed checkout label and foreign compose file)'
else
  fail "refusal warning missing: $(tr '\n' ' ' < "$SHIM_DIR/mixed.err")"
fi

# Fixture C: a pre-#356 legacy project that has since gained a foreign compose
# file is refused too — the unlabelled fallback is not a blanket bypass.
cat > "$SHIM_DIR/fixture-legacy-mixed" <<FIXTURE
legacy-1 $LEGACY /compose/ours.yml
legacy-mixed-1 $LEGACY /compose/ours.yml
legacy-mixed-2 $LEGACY /compose/other.yml
FIXTURE
export DOCKER_FIXTURE="$SHIM_DIR/fixture-legacy-mixed"
RC=0
SWEPT="$(PATH="$SHIM_DIR:$PATH" stack_sweep_projects '/checkout/ours' '/compose/ours.yml' 2> /dev/null)" || RC=$?
if ((RC == 3)) && [[ -z "$SWEPT" ]]; then
  pass 'a legacy project that gained a foreign container is refused too (unlabelled fallback is not a bypass)'
else
  fail "legacy mixed handling wrong: rc $RC, stdout '$SWEPT'"
fi

# A docker failure must surface (rc 1), not look like "no stack to clean".
export DOCKER_FIXTURE="$SHIM_DIR/fixture-clean"
RC=0
PATH="$SHIM_DIR:$PATH" DOCKER_FAIL_PS=1 stack_sweep_projects '/checkout/ours' '/compose/ours.yml' > /dev/null 2>&1 || RC=$?
if ((RC == 1)); then
  pass 'docker ps failure surfaces instead of being swallowed as an empty sweep'
else
  fail "docker ps failure produced rc $RC (must be 1)"
fi

RC=0
PATH="$SHIM_DIR:$PATH" DOCKER_FAIL_INSPECT=1 stack_sweep_projects '/checkout/ours' '/compose/ours.yml' > /dev/null 2>&1 || RC=$?
if ((RC == 1)); then
  pass 'docker inspect failure surfaces instead of being read as an empty label'
else
  fail "docker inspect failure produced rc $RC (must be 1)"
fi

if [[ -z "$(PATH="$SHIM_DIR:$PATH" stack_sweep_projects '' '/compose/ours.yml')" ]]; then
  pass 'empty checkout filter sweeps nothing (no accidental global down)'
else
  fail 'an empty checkout filter swept containers'
fi

# ------------------------------------------------------------------
# 8. Structural invariants (toolchain-only images, read-only mounts)
# ------------------------------------------------------------------
echo '==> toolchain-only image invariants'

for df in api web test-runner; do
  file="$ROOT_DIR/automation/docker/Dockerfile.$df"
  if grep -qE '^COPY (backend/src|frontend/src|contract/src|automation/tests)' "$file"; then
    fail "Dockerfile.$df copies repo source into the image (source must be mounted)"
  else
    pass "Dockerfile.$df does not bake repo source"
  fi
done

if grep -qE '^[[:space:]]*-[[:space:]]+[^#]*node_modules' "$COMPOSE_FILE"; then
  fail 'docker-compose.yml mounts node_modules (must never be mounted; deps live in the image)'
else
  pass 'docker-compose.yml never mounts node_modules'
fi

BAD_MOUNTS="$(grep -nE "^[[:space:]]*- \.\./(backend|frontend|contract|automation)/" "$COMPOSE_FILE" | grep -v ':ro' || true)"
if [[ -z "$BAD_MOUNTS" ]]; then
  pass 'every source mount is read-only (:ro)'
else
  fail "a source mount is writable: $BAD_MOUNTS"
fi

if grep -q "127.0.0.1::3000" "$COMPOSE_FILE"; then
  pass 'the default published port is ephemeral and loopback-only'
else
  fail 'docker-compose.yml lost the 127.0.0.1::3000 default (fixed/LAN port regression)'
fi

CHECKOUT_LABELS="$(grep -c 'rumaq.automation.checkout:' "$COMPOSE_FILE" || true)"
if ((CHECKOUT_LABELS == 4)); then
  pass 'all four services carry the checkout label (the proxy stays addressable after a killed run)'
else
  fail "expected 4 checkout labels (api/web/proxy/test-runner), found $CHECKOUT_LABELS"
fi

if grep -qE '^\s*required: false' "$COMPOSE_FILE"; then
  pass 'the proxy treats web as an optional dependency (--api skips the SPA build)'
else
  fail 'the proxy requires web unconditionally (--api would build the SPA needlessly)'
fi

if grep -q 'test-results/runs/${RUMAQ_RUN_ID' "$COMPOSE_FILE"; then
  pass 'test reports mount a per-run directory (concurrent runs cannot overwrite each other)'
else
  fail 'test reports still mount the shared test-results/{vitest,playwright,artifacts} paths'
fi

if grep -q 'external: true' "$COMPOSE_FILE"; then
  pass 'the build-cache volume is external (survives per-run down -v)'
else
  fail 'the build-cache volume is not external (down -v could delete another run cache)'
fi

for script in build-cache.sh entrypoint-api.sh entrypoint-web.sh entrypoint-test-runner.sh; do
  if [[ -x "$ROOT_DIR/automation/docker/$script" ]]; then
    pass "$script is executable"
  else
    fail "$script is not executable (chmod +x + .gitattributes mode=755)"
  fi
done
if grep -q 'automation/\*\*/\*\.sh text eol=lf mode=755' "$ROOT_DIR/.gitattributes"; then
  pass '.gitattributes tracks automation shell scripts as mode=755'
else
  fail '.gitattributes does not mark automation shell scripts mode=755'
fi

# ------------------------------------------------------------------
# 9. Build-cache content hash (#356 review B8)
# ------------------------------------------------------------------
echo '==> build-cache stamp'

CACHE_TREE="$(mktemp -d)"
printf 'a\n' > "$CACHE_TREE/a.txt"
STAMP_PLAIN="$(
  RUMAQ_CACHE_DIR="$CACHE_TREE/cache" bash -c '
    set -euo pipefail
    source "$1"
    cache_stamp "$2"
  ' _ "$ROOT_DIR/automation/docker/build-cache.sh" "$CACHE_TREE"
)"
if [[ "$STAMP_PLAIN" =~ ^[0-9a-f]{16}$ ]]; then
  pass "cache stamp is a 16-hex content hash ('$STAMP_PLAIN')"
else
  fail "cache stamp has an unexpected shape: '$STAMP_PLAIN'"
fi

ln -s a.txt "$CACHE_TREE/link"
STAMP_LINK="$(
  RUMAQ_CACHE_DIR="$CACHE_TREE/cache" bash -c '
    set -euo pipefail
    source "$1"
    cache_stamp "$2"
  ' _ "$ROOT_DIR/automation/docker/build-cache.sh" "$CACHE_TREE" 2> /dev/null
)"
if [[ "$STAMP_LINK" =~ ^uncacheable- ]] && [[ "$STAMP_LINK" != "$STAMP_PLAIN" ]]; then
  pass 'a symlinked input fails closed instead of hashing only the regular files'
else
  fail "symlink input produced '$STAMP_LINK' (must be an uncacheable stamp)"
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
if ((failures == 0)); then
  echo 'automation stack: ok'
  exit 0
fi

echo "automation stack: $failures failure(s)" >&2
exit 1
