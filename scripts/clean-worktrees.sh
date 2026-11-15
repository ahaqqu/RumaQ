#!/usr/bin/env bash
# Worktree hygiene sweep (#682): remove stale RumaQ worktrees and the
# root-owned E2E artifact remnants the Docker runner leaves behind, then
# report the reclaimed disk. The primary checkout is never touched; dirty
# trees and unmerged branches are reported, never removed.
#
# Classes:
#   1. REGISTERED worktrees (git worktree list, minus the primary checkout):
#      removed only when the tree is clean AND the branch work is provably in
#      main — an ancestor of origin/main, or its PR is MERGED with the exact
#      head commit (this repo squash-merges, so ancestry alone never fires) —
#      AND, unprivileged, no root-owned files inside. A detached HEAD has no
#      branch for the PR oracle, so it is removed only when its HEAD commit is
#      an ancestor of origin/main. The gh head match reads the branch head as
#      GitHub sees it now: commits pushed to a branch after its merge make a
#      worktree on them removable, though the branch ref keeps every commit
#      reachable, so nothing is lost permanently. A tree sitting exactly at
#      the current main tip is always kept: that is what a freshly created
#      task worktree looks like before its first commit.
#   2. ORPHAN directories (~/Projects/RumaQ-wt-* and ~/Projects/RumaQ.wt/*
#      not registered in git): a git repo inside is removed when clean AND
#      every commit it holds locally — all branch tips plus a detached HEAD —
#      is an ancestor of its own origin/main; empty remnants are removed;
#      anything else is reported. Directories that hold registered worktrees
#      are never treated as orphans.
#   3. ROOT-OWNED remnants (the E2E runner writes automation/test-results
#      under Docker as root): unremovable unprivileged, so they park the
#      containing directory in the sudo class. The single documented owner
#      invocation removes them:  sudo scripts/clean-worktrees.sh
#
# Usage:
#   ./scripts/clean-worktrees.sh --list   dry-run report + reclaim estimate
#   ./scripts/clean-worktrees.sh          remove + before/after du totals
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/clean-worktrees.sh [--list|--root|--help]

  --list   dry-run: report removable, sudo-class and kept directories with a
           reclaim estimate; nothing is changed.
  --root   accepted for the documented sudo invocation; root-owned removal is
           gated by actually running under sudo, never by this flag alone.
EOF
}

LIST_MODE=0
for arg in "$@"; do
  case $arg in
    --list) LIST_MODE=1 ;;
    --root) ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "clean-worktrees: unknown option $arg (supported: --list --root --help)" >&2
      exit 1
      ;;
  esac
done

MAIN_REPO="$(cd "$(dirname "$0")/.." && pwd)"
: "${MAIN_REPO:?RumaQ repo root not found}"

if [[ ${EUID} -eq 0 ]]; then
  # The sudo pass legitimately runs git and gh against the user-owned
  # checkout: silence the dubious-ownership refusal and reuse the invoking
  # user gh auth so the merge oracle keeps working in that single pass.
  # GIT_OPTIONAL_LOCKS=0 stops status from refreshing user-owned index files
  # as root: the sudo pass must not mint new root-owned files inside the
  # checkout it is cleaning up.
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=safe.directory
  export GIT_CONFIG_VALUE_0='*'
  export GIT_OPTIONAL_LOCKS=0
  if [[ -n ${SUDO_USER:-} ]]; then
    sudo_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
    if [[ -n $sudo_home && -d $sudo_home/.config/gh ]]; then
      export GH_CONFIG_DIR="$sudo_home/.config/gh"
    fi
  fi
fi

PRIMARY="$(git -C "$MAIN_REPO" worktree list --porcelain | sed -n 's/^worktree //p' | head -n 1)"
: "${PRIMARY:?RumaQ primary checkout not found}"
PROJECTS="$(dirname "$PRIMARY")"
: "${PROJECTS:?parent directory of the primary checkout not found}"

cd "$PRIMARY"

# Refresh the merge oracle. Best effort: offline and sudo runs keep going on
# the locally fetched refs.
if ! git fetch origin main --quiet 2>/dev/null; then
  echo "  warn  git fetch failed, merge checks use the local refs" >&2
fi
MERGE_TARGET=main
if git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null 2>&1; then
  MERGE_TARGET=origin/main
fi
: "${MERGE_TARGET:?merge target ref not found}"

git worktree prune

GH_OK=1
command -v gh >/dev/null 2>&1 || GH_OK=0
PRIMARY_BRANCH="$(git branch --show-current)"
MAIN_TIP="$(git rev-parse "$MERGE_TARGET" 2>/dev/null)"

MERGE_VIA=""
# branch_merged <branch> <tip>: exit 0 when the branch work is provably in
# main. Squash merges never make the source branch an ancestor, so the gh PR
# oracle closes the gap ancestry alone leaves open.
branch_merged() {
  local branch=$1 tip=$2 pr state oid
  MERGE_VIA=""
  if git merge-base --is-ancestor "$tip" "$MERGE_TARGET" >/dev/null 2>&1; then
    MERGE_VIA="ancestor of ${MERGE_TARGET}"
    return 0
  fi
  if [[ $GH_OK -eq 1 ]]; then
    # headRefOid is the branch head as GitHub sees it NOW, so a branch pushed
    # after its merge satisfies this match too. The sweep of such a worktree
    # loses nothing permanent — the branch ref keeps every commit reachable —
    # but the directory goes; re-add it with git worktree add if needed.
    if pr="$(gh pr view "$branch" --json state,headRefOid,number --jq '[.state, .headRefOid, (.number | tostring)] | join(" ")' 2>/dev/null)" &&
      [[ -n $pr ]]; then
      state="${pr%% *}"
      oid="${pr#* }"
      oid="${oid%% *}"
      if [[ $state == MERGED && $oid == "$tip" ]]; then
        MERGE_VIA="PR #${pr##* } merged"
        return 0
      fi
    fi
  fi
  return 1
}

scan_root_owned() {
  # Sets ROOT_COUNT and ROOT_SCAN_OK for the given directory.
  local dir=$1
  ROOT_SCAN_OK=1
  ROOT_PATHS="$(find "$dir" -user root -print 2>/dev/null)" || ROOT_SCAN_OK=0
  ROOT_COUNT=0
  if [[ -n $ROOT_PATHS ]]; then
    ROOT_COUNT="$(printf '%s\n' "$ROOT_PATHS" | wc -l)"
  fi
}

dir_kb() {
  local k
  k="$(du -sk "$1" 2>/dev/null | cut -f1)"
  echo "${k:-0}"
}

human_kb() {
  local bytes=$(( $1 * 1024 ))
  numfmt --to=iec-i --suffix=B "$bytes" 2>/dev/null || echo "${1}KB"
}

# Results: "act|kind|path|reason" lines in discovery order; kind selects the
# removal method (registered worktrees via git, orphan directories via rm).
RESULTS=()
REG_PATHS=()

decide_registered() {
  local wt=$1 ref=$2 st st_ok tip kb
  REG_PATHS+=("$wt")
  kb="$(dir_kb "$wt")"

  st_ok=1
  st="$(git -C "$wt" status --porcelain 2>/dev/null)" || st_ok=0
  if [[ $st_ok -eq 0 ]]; then
    RESULTS+=("keep|reg|$wt|unreadable working tree (needs root or manual attention)|$kb")
    return
  fi
  if [[ -n $st ]]; then
    RESULTS+=("keep|reg|$wt|dirty working tree ($(printf '%s\n' "$st" | wc -l) changes)|$kb")
    return
  fi

  scan_root_owned "$wt"
  if [[ ${EUID} -ne 0 && ($ROOT_COUNT -gt 0 || $ROOT_SCAN_OK -eq 0) ]]; then
    RESULTS+=("sudo|reg|$wt|root-owned files inside ($ROOT_COUNT)|$kb")
    return
  fi

  tip="$(git -C "$wt" rev-parse HEAD 2>/dev/null)" || tip=""
  if [[ -z $tip ]]; then
    RESULTS+=("keep|reg|$wt|unreadable HEAD|$kb")
    return
  fi
  # A tree sitting exactly at the current main tip is what a freshly created
  # task worktree looks like (worktree add -b ... origin/main, no commits
  # yet); sweeping it would eat active work. Conservatively keep those even
  # though the branch is technically fully merged.
  if [[ $tip == "$MAIN_TIP" ]]; then
    RESULTS+=("keep|reg|$wt|clean, sitting at the current main tip|$kb")
    return
  fi
  if [[ $ref == DETACHED ]]; then
    # No branch ref and no PR to ask: only ancestry proves a detached HEAD is
    # in main. Removing an unmerged detached HEAD orphans its commits for the
    # next git gc — git worktree remove does not check mergedness.
    if git merge-base --is-ancestor "$tip" "$MERGE_TARGET" >/dev/null 2>&1; then
      RESULTS+=("remove|reg|$wt|clean detached HEAD, ancestor of ${MERGE_TARGET}|$kb")
    else
      RESULTS+=("keep|reg|$wt|clean detached HEAD not merged|$kb")
    fi
    return
  fi
  if [[ $ref == "$PRIMARY_BRANCH" && -n $PRIMARY_BRANCH ]]; then
    RESULTS+=("keep|reg|$wt|branch checked out by the primary checkout|$kb")
    return
  fi
  if branch_merged "$ref" "$tip"; then
    RESULTS+=("remove|reg|$wt|clean, ${MERGE_VIA}|$kb")
  else
    RESULTS+=("keep|reg|$wt|clean but branch ${ref} not merged|$kb")
  fi
}

while IFS=$'\t' read -r wt ref; do
  [[ $wt == "$PRIMARY" ]] && continue
  [[ $ref == BARE ]] && continue
  decide_registered "$wt" "$ref"
done < <(git worktree list --porcelain | awk '
  /^worktree / { path = substr($0, 10); ref = "" }
  /^branch /   { ref = substr($0, 8); sub(/^refs\/heads\//, "", ref) }
  /^detached/  { ref = "DETACHED" }
  /^bare/      { ref = "BARE" }
  /^$/ {
    if (path != "" && ref != "") print path "\t" ref
    path = ""; ref = ""
  }
  END { if (path != "" && ref != "") print path "\t" ref }
')

# orphan_repo_merged <dir>: every commit the unregistered repo holds locally —
# each local branch tip plus a detached HEAD — is an ancestor of its own
# origin/main. Ancestry against its own fetched remote proves the commits
# exist upstream; the primary checkout's git knows nothing about an
# unregistered repo's branches, so without that proof the directory is kept.
orphan_repo_merged() {
  local d=$1 target b
  target="$(git -C "$d" rev-parse --verify --quiet refs/remotes/origin/main 2>/dev/null)" || return 1
  while read -r b; do
    git -C "$d" merge-base --is-ancestor "$b" "$target" >/dev/null 2>&1 || return 1
  done < <(git -C "$d" for-each-ref --format='%(objectname)' refs/heads/)
  git -C "$d" merge-base --is-ancestor HEAD "$target" >/dev/null 2>&1 || return 1
  return 0
}

# Orphan candidates: RumaQ worktree-shaped directories that git no longer
# knows about. Directories holding registered worktrees (for example the
# RumaQ-wt-bulk parent) are excluded so their children classify themselves.
decide_orphan() {
  local dir=$1 st st_ok kb entries
  kb="$(dir_kb "$dir")"
  st_ok=1
  st="$(git -C "$dir" status --porcelain 2>/dev/null)" || st_ok=0
  if [[ $st_ok -eq 1 && $(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) == "$dir" ]]; then
    if [[ -z $st ]]; then
      if orphan_repo_merged "$dir"; then
        RESULTS+=("remove|orph|$dir|unregistered but clean, branch work in its origin/main|$kb")
      else
        RESULTS+=("keep|orph|$dir|clean but local branch work not provably in its origin/main|$kb")
      fi
    else
      RESULTS+=("keep|orph|$dir|dirty ($(printf '%s\n' "$st" | wc -l) changes)|$kb")
    fi
    return
  fi
  # No usable git metadata here: only emptiness or the sudo pass makes it
  # safely removable.
  scan_root_owned "$dir"
  entries="$(ls -A "$dir" 2>/dev/null | wc -l)"
  if [[ ${EUID} -ne 0 && ($ROOT_COUNT -gt 0 || $ROOT_SCAN_OK -eq 0) ]]; then
    RESULTS+=("sudo|orph|$dir|root-owned remnants, git metadata gone ($ROOT_COUNT)|$kb")
    return
  fi
  if [[ $entries -eq 0 ]]; then
    RESULTS+=("remove|orph|$dir|empty remnant|$kb")
    return
  fi
  RESULTS+=("keep|orph|$dir|git metadata gone, content unverifiable|$kb")
}

shopt -s nullglob
for dir in "$PROJECTS"/RumaQ-wt-* "$PROJECTS"/RumaQ.wt/*; do
  [[ -d $dir ]] || continue
  is_known=0
  for reg in "${REG_PATHS[@]}"; do
    if [[ $reg == "$dir" || $reg == "$dir"/* ]]; then
      is_known=1
      break
    fi
  done
  [[ $is_known -eq 1 ]] && continue
  decide_orphan "$dir"
done
shopt -u nullglob

# Worktree-shaped disk footprint before any change (the primary checkout and
# everything outside the managed patterns is not counted).
disk_total_kb() {
  local total=0 d k
  for d in "$PROJECTS"/RumaQ-wt-* "$PROJECTS"/RumaQ.wt/*; do
    [[ -d $d ]] || continue
    k="$(dir_kb "$d")"
    total=$((total + ${k:-0}))
  done
  echo "$total"
}

if [[ $LIST_MODE -eq 1 ]]; then
  echo "==> RumaQ worktree sweep (--list, nothing is changed)"
  echo "    merge target: ${MERGE_TARGET}, primary checkout: ${PRIMARY}"
  removes=0
  sudo_count=0
  keeps=0
  removable_kb=0
  total_kb=0
  for entry in "${RESULTS[@]}"; do
    IFS='|' read -r act kind path reason kb <<< "$entry"
    total_kb=$((total_kb + ${kb:-0}))
    case $act in
      remove)
        removes=$((removes + 1))
        removable_kb=$((removable_kb + ${kb:-0}))
        printf '  REMOVE  %-9s %s\n' "$(human_kb "$kb")" "$path — ${reason}"
        ;;
      sudo)
        sudo_count=$((sudo_count + 1))
        removable_kb=$((removable_kb + ${kb:-0}))
        printf '  SUDO    %-9s %s\n' "$(human_kb "$kb")" "$path — ${reason}"
        ;;
      keep)
        keeps=$((keeps + 1))
        printf '  KEEP    %-9s %s\n' "$(human_kb "$kb")" "$path — ${reason}"
        ;;
    esac
  done
  echo "==> ${removes} removable + ${sudo_count} sudo-class of $((removes + sudo_count + keeps)) entries"
  echo "    reclaimable now or via sudo: $(human_kb "$removable_kb") of $(human_kb "$total_kb")"
  if [[ $sudo_count -gt 0 ]]; then
    echo "    sudo pass: sudo scripts/clean-worktrees.sh"
  fi
  exit 0
fi

# Execute mode.
BEFORE_KB="$(disk_total_kb)"
removed=0
failures=0
reclaimed_kb=0
echo "==> before: $(human_kb "$BEFORE_KB") across RumaQ worktree directories"
for entry in "${RESULTS[@]}"; do
  IFS='|' read -r act kind path reason kb <<< "$entry"
  case $act in
    remove)
      size="$(human_kb "$kb")"
      if [[ $kind == reg ]]; then
        if git worktree remove "$path" 2>/dev/null; then
          echo "  removed ${size}  ${path}"
          removed=$((removed + 1))
          reclaimed_kb=$((reclaimed_kb + ${kb:-0}))
        else
          echo "  FAILED ${size}  ${path} — git worktree remove refused"
          failures=$((failures + 1))
        fi
      else
        if rm -rf -- "$path"; then
          echo "  removed ${size}  ${path}"
          removed=$((removed + 1))
          reclaimed_kb=$((reclaimed_kb + ${kb:-0}))
        else
          echo "  FAILED ${size}  ${path} — rm -rf refused"
          failures=$((failures + 1))
        fi
      fi
      ;;
    sudo)
      echo "  sudo-needed  ${kb}KB  ${path} — ${reason}"
      ;;
    keep)
      echo "  kept  ${kb}KB  ${path} — ${reason}"
      ;;
  esac
done

# Empty RumaQ-shaped parents left behind by removed children (rmdir only
# removes truly empty directories).
for parent in "$PROJECTS"/RumaQ-wt-* "$PROJECTS"/RumaQ.wt; do
  [[ -d $parent ]] || continue
  rmdir "$parent" 2>/dev/null || true
done

AFTER_KB="$(disk_total_kb)"
remaining="$(git worktree list | tail -n +2 | wc -l)"
echo "==> after: $(human_kb "$AFTER_KB") across RumaQ worktree directories"
echo "==> removed ${removed} directories, reclaimed ~$(human_kb "$reclaimed_kb")"
echo "==> remaining registered worktrees: ${remaining}"

if [[ $failures -gt 0 ]]; then
  echo "==> ${failures} removal(s) failed — see the FAILED lines above" >&2
  exit 1
fi
