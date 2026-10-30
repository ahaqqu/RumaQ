#!/usr/bin/env bash
# scripts/test/vps-deploy.sh — invariant test for the scraper deploy artifact.
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
# It drives verify_artifact() with handcrafted tars, then runs the real build
# in --dry-run with failing ssh/rsync shims on PATH: the produced archive must
# pass the verifier and the dry run must contact no host.
#
# Run: bash scripts/test/vps-deploy.sh  (CI runs it from scripts/github/ci.sh)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rumaq-vps-deploy-test-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# shellcheck source=../deploy/vps.sh
. "$ROOT_DIR/scripts/deploy/vps.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok   %s\n' "$*"; }

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
pass "real build passes the verifier; dry run contacts no host"

printf '\n✓ vps deploy artifact invariants hold\n'
