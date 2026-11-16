#!/usr/bin/env bash
set -euo pipefail

# Offline guard for the change-set resolver (scripts/github/changed-paths.sh).
#
# The resolver answers "what does this pull request change". A branch that is
# behind its base must not inherit the base's own newer commits: the event's
# base_sha can be the fork point, and a two-dot diff against it lists
# everything main gained since — which ran every scope gate on a docs-only PR
# (#695). The base-branch path must report only the PR's own paths, also when
# the base moves again after the merge commit was built.
#
# Offline only: a throwaway origin with one merge commit, no network.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT_DIR/scripts/github/changed-paths.sh"
failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ change-set resolver)\n' "$1" >&2
  failures=$((failures + 1))
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git init -q --bare "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/work" 2>/dev/null
git -C "$tmp/work" config user.name test
git -C "$tmp/work" config user.email test@example.com
git -C "$tmp/work" config commit.gpgsign false

# A: the fork point.
echo base >"$tmp/work/base.txt"
git -C "$tmp/work" add -A
git -C "$tmp/work" commit -qm base
git -C "$tmp/work" branch -M main
git -C "$tmp/work" push -q origin main
fork=$(git -C "$tmp/work" rev-parse HEAD)

# The PR: one docs commit off A.
git -C "$tmp/work" checkout -q -b pr
mkdir -p "$tmp/work/docs"
echo report >"$tmp/work/docs/report.md"
git -C "$tmp/work" add -A
git -C "$tmp/work" commit -qm docs
git -C "$tmp/work" push -q origin pr

# main moves ahead with a code change the PR must not inherit.
git -C "$tmp/work" checkout -q main
echo code >"$tmp/work/code.js"
git -C "$tmp/work" add -A
git -C "$tmp/work" commit -qm code
git -C "$tmp/work" push -q origin main
base_tip=$(git -C "$tmp/work" rev-parse HEAD)

# The merge ref the PR workflows check out.
git -C "$tmp/work" merge -q --no-ff pr -m "Merge pr into main"
git -C "$tmp/work" push -q origin HEAD:refs/pull/1/merge

# The CI-shaped checkout: shallow, the merge ref only.
git init -q "$tmp/check"
cd "$tmp/check"
git remote add origin "$tmp/origin.git"
git fetch -q --depth=1 origin refs/pull/1/merge
git checkout -q FETCH_HEAD
mkdir -p scripts/github
cp "$SRC" scripts/github/changed-paths.sh
# The copied script is scaffolding, not part of the change set.
printf 'scripts/\n' >>.git/info/exclude

# resolve <out> <env assignment...>: run the resolver with the given environment.
resolve() {
  local out=$1
  shift
  env -u GITHUB_BASE_REF -u PR_BASE_SHA -u GITHUB_REF "$@" bash scripts/github/changed-paths.sh 2>/dev/null |
    sed '/^$/d' >"$out" || true
}

# 1. The regression: a stale base_sha must not widen the change set.
resolve "$tmp/got1" GITHUB_BASE_REF=main PR_BASE_SHA="$fork" GITHUB_REF=refs/pull/1/merge
if [ "$(cat "$tmp/got1")" = "docs/report.md" ]; then
  pass 'behind-base PR reports only its own path'
else
  fail "behind-base PR reports $(tr '\n' ' ' <"$tmp/got1")"
fi

# 2. The race: main moves again after the merge commit was built, on its own
# tip (not through the merge ref).
git -C "$tmp/work" reset -q --hard "$base_tip"
echo later >"$tmp/work/later.js"
git -C "$tmp/work" add -A
git -C "$tmp/work" commit -qm later
git -C "$tmp/work" push -q origin main
resolve "$tmp/got2" GITHUB_BASE_REF=main PR_BASE_SHA="$base_tip" GITHUB_REF=refs/pull/1/merge
if [ "$(cat "$tmp/got2")" = "docs/report.md" ]; then
  pass 'base moved after the merge ref still reports only the PR path'
else
  fail "moved base reports $(tr '\n' ' ' <"$tmp/got2")"
fi

# 3. Fail safe: an unreachable base leaves the set unknown, never a skip.
resolve "$tmp/got3" GITHUB_BASE_REF=no-such-branch GITHUB_REF=refs/pull/1/merge
if [ ! -s "$tmp/got3" ]; then
  pass 'unreachable base ref prints nothing (callers run)'
else
  fail "unreachable base ref printed $(tr '\n' ' ' <"$tmp/got3")"
fi

if [ "$failures" -eq 0 ]; then
  echo 'change-set resolver: ok'
  exit 0
fi

echo "change-set resolver: $failures failure(s)" >&2
exit 1
