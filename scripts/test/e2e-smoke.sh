#!/usr/bin/env bash
set -euo pipefail

# Offline guard for the fast PR E2E smoke subset (ahaqqu/RumaQ#657, phase 1).
#
# The @smoke tags in the existing feature files are the single source of truth:
# `./scripts/test.sh automation-local --smoke` greps them with Playwright's
# native --grep and the nightly runs every scenario unfiltered. This guard keeps
# the set honest without naming the scenarios:
#   - 3-5 tagged scenarios: the cap forces a deliberate trade instead of creep;
#   - at least one tagged scenario in each anchor feature (smoke, add-receipt,
#     prices-explorer), so a risk class cannot silently disappear;
#   - @smoke only on a plain Scenario, never a Feature, Background, Scenario
#     Outline or Examples line (a feature tag would drag in every scenario and
#     an outline would multiply the set).
#
# It prints the selected file:line — scenario list, so a reviewer sees exactly
# what the fast mode runs. Offline only: reads the feature files, no Docker and
# no network.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
FEATURES_DIR="$ROOT_DIR/automation/tests/local/e2e/features"
ANCHORS=(smoke add-receipt prices-explorer)
MIN_SCENARIOS=3
MAX_SCENARIOS=5
failures=0

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s (ahaqqu/RumaQ#657)\n' "$1" >&2
  failures=$((failures + 1))
}

if [[ ! -d "$FEATURES_DIR" ]]; then
  echo "e2e smoke: features directory missing: $FEATURES_DIR" >&2
  exit 1
fi

# Emit one record per @smoke tag block:
#   SCENARIO<TAB>file<TAB>line<TAB>title
#   VIOLATION<TAB>file<TAB>line<TAB>message
# Blank lines and comments between a tag block and its declaration keep the
# block open, matching Gherkin's tag parsing.
read -r -d '' AWK_PROGRAM <<'AWK' || true
function reset() {
  tags = ""
  tag_line = 0
  pending = 0
}

function has_smoke(   parts, count, i) {
  count = split(tags, parts, /[[:space:]]+/)
  for (i = 1; i <= count; i++) {
    if (parts[i] == "@smoke") {
      return 1
    }
  }
  return 0
}

BEGIN { reset() }

/^[[:space:]]*@/ {
  if (!pending) {
    pending = 1
    tag_line = NR
  }
  tags = tags " " $0
  next
}

pending {
  if ($0 ~ /^[[:space:]]*(#|$)/) {
    next
  }
  if (has_smoke()) {
    declaration = $0
    sub(/^[[:space:]]+/, "", declaration)
    if (declaration ~ /^Feature:/) {
      print "VIOLATION\t" FILENAME "\t" tag_line "\t@smoke tags a Feature (every scenario would run)"
    } else if (declaration ~ /^Background:/) {
      print "VIOLATION\t" FILENAME "\t" tag_line "\t@smoke tags a Background"
    } else if (declaration ~ /^Scenario Outline:/) {
      print "VIOLATION\t" FILENAME "\t" tag_line "\t@smoke tags a Scenario Outline (the set would multiply)"
    } else if (declaration ~ /^Examples:/) {
      print "VIOLATION\t" FILENAME "\t" tag_line "\t@smoke tags an Examples block"
    } else if (declaration ~ /^Scenario:/) {
      title = declaration
      sub(/^Scenario:[[:space:]]*/, "", title)
      print "SCENARIO\t" FILENAME "\t" NR "\t" title
    } else {
      print "VIOLATION\t" FILENAME "\t" tag_line "\t@smoke is not attached to a Scenario line"
    }
  }
  reset()
}

END {
  if (pending && has_smoke()) {
    print "VIOLATION\t" FILENAME "\t" tag_line "\t@smoke has no Scenario to attach to (end of file)"
  }
}
AWK

shopt -s nullglob
feature_files=("$FEATURES_DIR"/*.feature)
shopt -u nullglob

records=()
for feature in "${feature_files[@]}"; do
  while IFS= read -r record; do
    [[ -n "$record" ]] && records+=("$record")
  done < <(awk "$AWK_PROGRAM" "$feature")
done

echo '==> @smoke selected scenarios'

count=0
declare -A anchor_hits=()
for record in "${records[@]}"; do
  IFS=$'\t' read -r kind file line detail <<< "$record"
  rel="${file#"$ROOT_DIR"/}"
  case "$kind" in
    SCENARIO)
      count=$((count + 1))
      printf '  tagged  %s:%s — %s\n' "$rel" "$line" "$detail"
      anchor_hits["$(basename "$file")"]=1
      ;;
    VIOLATION)
      fail "$rel:$line — $detail"
      ;;
    *)
      fail "unexpected guard record: $record"
      ;;
  esac
done

if ((count < MIN_SCENARIOS || count > MAX_SCENARIOS)); then
  fail "expected ${MIN_SCENARIOS}-${MAX_SCENARIOS} @smoke scenarios, found $count"
else
  pass "$count @smoke scenarios (allowed ${MIN_SCENARIOS}-${MAX_SCENARIOS})"
fi

for anchor in "${ANCHORS[@]}"; do
  key="$anchor.feature"
  if [[ -n "${anchor_hits[$key]+set}" ]]; then
    pass "anchor present: $key"
  else
    fail "anchor feature has no @smoke scenario: $key"
  fi
done

if ((failures == 0)); then
  echo 'e2e smoke: ok'
  exit 0
fi

echo "e2e smoke: $failures failure(s)" >&2
exit 1
