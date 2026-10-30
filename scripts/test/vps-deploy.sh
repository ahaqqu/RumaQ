#!/usr/bin/env bash
# scripts/test/vps-deploy.sh — invariant test for the scraper deploy.
#
# The deploy succeeds only if the archive is exactly what vps-deploy accepts:
# relative regular files and directories, with both bundles and the real
# playwright-core package, no browsers/ (the preserved Chromium cache), and
# within rumaq/deploy.conf's compressed/unpacked caps. Every violation below
# would otherwise surface on the box after the upload — the failure the helper
# cannot explain, or a green deploy that leaves the agent on old code:
#
#   - a symlink in node_modules (Bun's .bin links are symlinks)  -> helper refuses
#   - browsers/ staged into the artifact                         -> preserve preflight refuses
#   - a missing bundle or playwright-core package                -> fails at 06:00 WIB
#   - an absolute or ../ member                                  -> helper refuses
#   - an oversized archive or entry                              -> refused after upload
#
# It drives verify_artifact() from scripts/deploy/artifact.sh with handcrafted
# tars, then runs the real build in --dry-run with failing ssh/rsync shims on
# PATH: the produced archive must pass the verifier and the dry run must contact
# no host. Finally it drives ship() with fake ssh/rsync shims: the shared doctor
# gate must run after `vps-deploy rumaq` and every non-zero result must fail the
# deploy. Sourcing the libraries must not change this shell.
#
# Run: bash scripts/test/vps-deploy.sh  (CI runs it from scripts/github/ci.sh)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rumaq-vps-deploy-test-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok   %s\n' "$*"; }

artifact_lib="$ROOT_DIR/scripts/deploy/artifact.sh"
vps_lib="$ROOT_DIR/scripts/deploy/vps.sh"

# --- 0. the libraries are source-only and the caps are the contract's --------
# vps.sh is both the CLI and the library this test sources for ship()/
# run_doctor(); sourcing either file must leave this shell's options and
# variables alone. The two caps are rumaq/deploy.conf's max_bytes /
# max_unpacked_bytes in ahaqqu/vps.
if (
  set +e
  set +u
  set -o pipefail
  unset ROOT_DIR APP ARTIFACT REMOTE_ARTIFACT RUMAQ_VPS_USER SSH_OPTS DRY_RUN WORKDIR
  before="$(set +o)"
  # shellcheck source=../deploy/artifact.sh
  . "$artifact_lib"
  # shellcheck source=../deploy/vps.sh
  . "$vps_lib"
  after="$(set +o)"
  [ "$before" = "$after" ] || exit 1
  for name in ROOT_DIR APP ARTIFACT REMOTE_ARTIFACT RUMAQ_VPS_USER SSH_OPTS DRY_RUN WORKDIR; do
    [ -z "${!name:-}" ] || exit 1
  done
); then
  pass "sourcing artifact.sh + vps.sh leaves the caller's shell alone"
else
  fail "sourcing a deploy library changed the caller's shell options or variables"
fi

# shellcheck source=../deploy/artifact.sh
. "$artifact_lib"

[ "$MAX_COMPRESSED_BYTES" -eq 536870912 ] ||
  fail "MAX_COMPRESSED_BYTES is $MAX_COMPRESSED_BYTES, not the contract's 536870912"
[ "$MAX_UNPACKED_BYTES" -eq 1073741824 ] ||
  fail "MAX_UNPACKED_BYTES is $MAX_UNPACKED_BYTES, not the contract's 1073741824"
pass "the caps match rumaq/deploy.conf"

# make_stage <dir> — the minimum a deployable artifact carries.
make_stage() {
  local dir="$1"
  mkdir -p "$dir/dist" "$dir/node_modules/playwright-core"
  printf '// index\n' >"$dir/dist/index.js"
  printf '// agent\n' >"$dir/dist/agent.js"
  printf '{}\n' >"$dir/node_modules/playwright-core/package.json"
}

# make_tar <artifact> <stage> — the shipped shape: contents at the root.
make_tar() {
  tar -czf "$1" -C "$2" .
  chmod 0644 "$1"
}

expect_pass() {
  local name="$1" artifact="$2"
  (verify_artifact "$artifact") >/dev/null 2>&1 ||
    fail "$name: verifier rejected a valid artifact"
  pass "$name"
}

expect_reject() {
  local name="$1" pattern="$2" artifact="$3" out
  if out="$(verify_artifact "$artifact" 2>&1)"; then
    fail "$name: verifier accepted the artifact"
  fi
  grep -q "$pattern" <<<"$out" || fail "$name: wrong rejection: $out"
  pass "$name"
}

# --- 1. the valid shape -------------------------------------------------------
make_stage "$WORK/ok"
make_tar "$WORK/ok.tar.gz" "$WORK/ok"
expect_pass "valid artifact is accepted" "$WORK/ok.tar.gz"

# --- 2. missing entry points --------------------------------------------------
cp -r "$WORK/ok" "$WORK/no-agent"
rm "$WORK/no-agent/dist/agent.js"
make_tar "$WORK/no-agent.tar.gz" "$WORK/no-agent"
expect_reject "missing dist/agent.js" "missing ./dist/agent.js" "$WORK/no-agent.tar.gz"

cp -r "$WORK/ok" "$WORK/no-pw"
rm "$WORK/no-pw/node_modules/playwright-core/package.json"
make_tar "$WORK/no-pw.tar.gz" "$WORK/no-pw"
expect_reject "missing playwright-core package" "missing ./node_modules/playwright-core/package.json" \
  "$WORK/no-pw.tar.gz"

# --- 3. preserved state must not ship ----------------------------------------
cp -r "$WORK/ok" "$WORK/with-browsers"
mkdir -p "$WORK/with-browsers/browsers/chromium-1234"
printf 'binary' >"$WORK/with-browsers/browsers/chromium-1234/chrome"
make_tar "$WORK/with-browsers.tar.gz" "$WORK/with-browsers"
expect_reject "browsers/ is preserved state" "browsers/" "$WORK/with-browsers.tar.gz"

# --- 4. entries the helper refuses -------------------------------------------
cp -r "$WORK/ok" "$WORK/with-link"
ln -s /etc/passwd "$WORK/with-link/dist/link"
make_tar "$WORK/with-link.tar.gz" "$WORK/with-link"
expect_reject "symlink member" "non-regular entry" "$WORK/with-link.tar.gz"

cp -r "$WORK/ok" "$WORK/abs"
printf 'x' >"$WORK/abs-extra"
tar -cf "$WORK/abs.tar" -C "$WORK/abs" .
tar -rf "$WORK/abs.tar" --absolute-names "$WORK/abs-extra" 2>/dev/null
gzip -c "$WORK/abs.tar" >"$WORK/abs.tar.gz"
expect_reject "absolute member" "absolute:" "$WORK/abs.tar.gz"

tar -cf "$WORK/trav.tar" -C "$WORK/ok" .
tar -rf "$WORK/trav.tar" -C "$WORK" --transform='s|^|../|' abs-extra 2>/dev/null
gzip -c "$WORK/trav.tar" >"$WORK/trav.tar.gz"
expect_reject "upward-traversing member" "traverses upward" "$WORK/trav.tar.gz"

# --- 5. contract caps (overridden small so the arithmetic is testable) ------
if (MAX_COMPRESSED_BYTES=10 verify_artifact "$WORK/ok.tar.gz") >/dev/null 2>&1; then
  fail "compressed cap: oversized artifact accepted"
fi
pass "compressed cap is enforced"

if (MAX_UNPACKED_BYTES=10 verify_artifact "$WORK/ok.tar.gz") >/dev/null 2>&1; then
  fail "unpacked cap: oversized artifact accepted"
fi
pass "unpacked cap is enforced"

# --- 6. the real build passes the verifier and the dry run contacts nothing --
mkdir -p "$WORK/bin"
for tool in ssh rsync; do
  printf '#!/bin/sh\necho "unexpected %s call" >&2\nexit 99\n' "$tool" >"$WORK/bin/$tool"
  chmod +x "$WORK/bin/$tool"
done
if ! out="$(PATH="$WORK/bin:$PATH" "$ROOT_DIR/scripts/deploy/vps.sh" --dry-run 2>&1)"; then
  printf '%s\n' "$out" >&2
  fail "the real build failed its own verifier"
fi
for entry in ./dist/index.js ./dist/agent.js ./node_modules/playwright-core/package.json; do
  grep -qxF "$entry" <<<"$out" || fail "dry run did not report $entry"
done
grep -q 'vps-deploy rumaq' <<<"$out" || fail "dry run did not report the deploy command"
grep -q 'would upload to .*:/srv/vps-incoming/rumaq\.tar\.gz' <<<"$out" ||
  fail "dry run did not report the upload path"
grep -q 'bash /srv/vps-ops/doctor\.sh' <<<"$out" ||
  fail "dry run did not report the doctor gate"
pass "real build passes the verifier; dry run contacts no host"

# --- 7. --help prints the whole header, never code ---------------------------
if ! help="$(bash "$ROOT_DIR/scripts/deploy/vps.sh" --help)"; then
  fail "vps.sh --help exited non-zero"
fi
rule="$(sed -n '2s/^# //p' "$ROOT_DIR/scripts/deploy/vps.sh")"
[ "$(printf '%s\n' "$help" | sed -n '1p')" = "$rule" ] ||
  fail "--help does not start at the header rule"
[ "$(printf '%s\n' "$help" | sed -n '$p')" = "$rule" ] ||
  fail "--help stops before the end of the header"
grep -q 'No secret flows through this script' <<<"$help" ||
  fail "--help cuts off the header's last paragraph"
if grep -q 'set -euo pipefail' <<<"$help"; then
  fail "--help prints a code line"
fi
pass "--help prints the whole header, no code"

# --- 8. the shared doctor gate runs after vps-deploy and fails closed --------
# shellcheck source=../deploy/vps.sh
. "$vps_lib"

mkdir -p "$WORK/doctor-bin"
cat >"$WORK/doctor-bin/ssh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_SSH_LOG"
case " $* " in
  *" bash /srv/vps-ops/doctor.sh "*) exit "${FAKE_DOCTOR_EXIT:-0}" ;;
  *) exit "${FAKE_SSH_EXIT:-0}" ;;
esac
SH
printf '#!/bin/sh\nexit 0\n' >"$WORK/doctor-bin/rsync"
chmod +x "$WORK/doctor-bin/ssh" "$WORK/doctor-bin/rsync"

export FAKE_SSH_LOG="$WORK/ssh.log"
export FAKE_SSH_EXIT=0
export FAKE_DOCTOR_EXIT=0
export RUMAQ_VPS_HOST="box.example"
export RUMAQ_VPS_USER="rumaq-deploy"
: >"$FAKE_SSH_LOG"

if ! PATH="$WORK/doctor-bin:$PATH" ship "$WORK/ok.tar.gz" >"$WORK/ship.out" 2>&1; then
  cat "$WORK/ship.out" >&2
  fail "ship failed against a fake healthy host"
fi

expected_doctor="-o BatchMode=yes -o StrictHostKeyChecking=accept-new rumaq-deploy@box.example bash /srv/vps-ops/doctor.sh"
grep -qxF -- "$expected_doctor" "$FAKE_SSH_LOG" ||
  fail "ship did not run the literal remote command: $expected_doctor"
deploy_line="$(grep -nF 'sudo -n /usr/local/sbin/vps-deploy rumaq' "$FAKE_SSH_LOG" | head -n1 | cut -d: -f1)"
doctor_line="$(grep -nF 'bash /srv/vps-ops/doctor.sh' "$FAKE_SSH_LOG" | head -n1 | cut -d: -f1)"
[ -n "$deploy_line" ] || fail "ship did not run vps-deploy rumaq"
[ "$doctor_line" -gt "$deploy_line" ] || fail "the doctor gate ran before vps-deploy"
pass "ship runs the shared doctor gate after vps-deploy"

: >"$FAKE_SSH_LOG"
export FAKE_DOCTOR_EXIT=1
if out="$(PATH="$WORK/doctor-bin:$PATH" ship "$WORK/ok.tar.gz" 2>&1)"; then
  fail "ship accepted a non-zero doctor result"
fi
grep -q 'shared doctor gate failed' <<<"$out" ||
  fail "a failing doctor did not explain the failure: $out"
pass "a failing doctor fails the deploy"

: >"$FAKE_SSH_LOG"
export FAKE_DOCTOR_EXIT=127
if out="$(PATH="$WORK/doctor-bin:$PATH" ship "$WORK/ok.tar.gz" 2>&1)"; then
  fail "ship accepted a missing doctor gate"
fi
grep -q 'shared doctor gate is missing' <<<"$out" ||
  fail "a missing doctor did not explain the failure: $out"
pass "a missing doctor fails closed with a clear message"
export FAKE_DOCTOR_EXIT=0

# --- 9. the Chromium revision recovery pins the contract path ---------------
# A playwright-core bump installs a new revision into the preserved browsers/
# cache; Chromium's installer can leave 0700 directories, and the service user
# is not the deploy identity. The recovery must run as rumaq-deploy, install
# into the ahaqqu/vps contract's fixed browsers path and chmod that exact path
# so the next self-check can read it. The helper takes no path input, and a
# stale RUMAQ_VPS_ROOT must fail before it contacts the host.
unset RUMAQ_VPS_ROOT RUMAQ_VPS_USER
mkdir -p "$WORK/recover-bin"
cat >"$WORK/recover-bin/ssh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >"${FAKE_SSH_ARGS:?}"
cat >"${FAKE_SSH_STDIN:?}"
exit 0
SH
chmod +x "$WORK/recover-bin/ssh"

recover=(
  env
  PATH="$WORK/recover-bin:$PATH"
  FAKE_SSH_STDIN="$WORK/recover.stdin"
  FAKE_SSH_ARGS="$WORK/recover.args"
  RUMAQ_VPS_HOST="box.example"
)
recover_script="$ROOT_DIR/scripts/deploy/browser-revision.sh"
browsers=/srv/rumaq-scraper/browsers

if ! "${recover[@]}" bash "$recover_script" >"$WORK/recover.out" 2>&1; then
  cat "$WORK/recover.out" >&2
  fail "browser revision recovery failed against a fake host"
fi
grep -qxF -- 'rumaq-deploy@box.example' "$WORK/recover.args" ||
  fail "browser revision recovery does not target rumaq-deploy@<host>"
grep -qF 'install chromium' "$WORK/recover.stdin" ||
  fail "browser revision recovery does not install chromium"
grep -qF "PLAYWRIGHT_BROWSERS_PATH=$browsers" "$WORK/recover.stdin" ||
  fail "browser revision recovery does not install into $browsers"
grep -qF "chmod 755 $browsers" "$WORK/recover.stdin" ||
  fail "browser revision recovery does not widen $browsers"
grep -qF "chmod -R go+rX $browsers" "$WORK/recover.stdin" ||
  fail "browser revision recovery does not heal the modes on $browsers"
pass "browser revision recovery targets rumaq-deploy and heals $browsers"

for stale in /tmp/rumaq-scraper /srv/rumaq-scraper/../etc "$browsers"; do
  : >"$WORK/recover.args"
  if out="$("${recover[@]}" RUMAQ_VPS_ROOT="$stale" bash "$recover_script" 2>&1)"; then
    fail "browser revision recovery accepted RUMAQ_VPS_ROOT=$stale"
  fi
  grep -qF '/srv/rumaq-scraper' <<<"$out" ||
    fail "a rejected RUMAQ_VPS_ROOT did not name the contract path: $out"
  [ ! -s "$WORK/recover.args" ] ||
    fail "a rejected RUMAQ_VPS_ROOT still contacted the host"
done
pass "a wrong or traversing RUMAQ_VPS_ROOT fails before any host contact"

if ! "${recover[@]}" RUMAQ_VPS_ROOT=/srv/rumaq-scraper bash "$recover_script" \
  >"$WORK/recover.out" 2>&1; then
  cat "$WORK/recover.out" >&2
  fail "browser revision recovery rejected the contract root as RUMAQ_VPS_ROOT"
fi
pass "the contract root is the only accepted RUMAQ_VPS_ROOT"

printf '\n✓ vps deploy invariants hold\n'
