---
name: daily-report
description: Use when the owner asks for a daily report, "what needs me", a status briefing, or a read-only sweep of the project. Produces one compact, evidence-based briefing across manager state, issues/kanban drift, PRs/CI/deploy, nightly E2E, pipeline/VPS, MANUAL_ACTIONS, contract sync, local hygiene, audit/backup, and pending decisions. It reports only — it never mutates anything and never reads secrets. Triggers: daily report, what needs me, status briefing, where are we, morning report.
---

# Daily Report

Produce one compact briefing per run: what changed, what is red, what waits on the owner, and what an agent can do next. The report is read-only by construction — it observes, it never acts.

## Hard rules (must)

- **Must not mutate.** Never run `gh issue create|edit|close|reopen|comment`, `gh pr create|edit|close|merge|review|comment`, `gh project item-add|item-edit|item-archive`, `gh workflow run`, `gh run rerun|cancel|delete`, `gh secret|gh variable|gh release|gh repo edit`, any `gh api --method` other than GET, any `--apply`/`--fix` flag, `scripts/deploy.sh`, `scripts/test.sh`, `docker build|prune`, `git worktree remove`, or `git push`. The only writes allowed are scratch files under `$BRIEF`.
- **Never read secrets.** Do not read or display `.env`, `.dev.vars`, env files, session cookies, tokens, or credential values. Never paste a token, cookie, or secret into the report. If a credential would be required, write `not checked` — never source `.env` to get it.
- **Read APIs only.** Use `gh --json` / `gh ... view` and GitHub/Cloudflare read endpoints; use existing `scripts/` entrypoints when they exist. No other network calls.
- **Stay cheap.** One pass per section, targeted paths only: no repo-wide grep, no full test suite, no Docker builds, no `run download` of artifacts, no `--log` on huge green runs. Cap each section (see Output) instead of dumping data.
- **Unknown beats green.** On a failed, skipped, or unauthorized query write `unknown — <query>` or `not checked — <reason>`. Never infer a pass from a missing result.
- **Report only.** If asked to fix an item mid-report, finish the brief first; then act through the normal issue/PR workflow, never as part of this skill.

## Setup

Run from a RumaQ checkout (a worktree is fine); the manager state lives outside the repo.

```bash
REPO=ahaqqu/RumaQ
PIPE=ahaqqu/RumaQ-pipeline
PROJECT=4                     # Delivery Kanban (owner ahaqqu)
OWNER=ahaqqu
REPO_DIR=$(git rev-parse --show-toplevel)
PIPE_DIR="${RUMAQ_PIPELINE_DIR:-$HOME/Projects/RumaQ-pipeline}"
BRIEF=$(mktemp -d /tmp/daily-report.XXXXXX)
CUTOFF_30M=$(date -u -d '30 minutes ago' +%FT%TZ)
CUTOFF_3D=$(date -u -d '3 days ago' +%FT%TZ)
YDAY=$(date -u -d 'yesterday' +%F)
```

- Header time: `TZ=Asia/Jakarta date '+%Y-%m-%d %H:%M WIB'`.
- Window: since the previous report if the owner names one, else the last 24 hours. State the window in the header.
- If `$PIPE_DIR` is missing, report pipeline/contract/hygiene as `unknown — pipeline checkout not found` and continue with GitHub-only checks.
- The report is the only output. Do not paste command output or raw JSON.

## Procedure

Run the blocks in order. Each block writes scratch JSON under `$BRIEF`; summarise from it, do not dump it.

### 1. Manager state, goal, agents, jobs

```bash
STATE=$(ls -1t "$HOME"/.agents/manager/RumaQ/*/state.md 2>/dev/null | head -1)
sed -n '1,8p' "$STATE"
tail -60 "$STATE"
grep -nE '^## (Agents in flight|Blocked on user|Report log|Goal|Current)' "$STATE"
```

- Read the newest `state.md` by mtime. Its **last dated `##` section and the report log tail override stale headings**: the `Agents in flight` block may describe a previous wave, so trust the newest section.
- Extract: current goal/objective (title + newest section), active agents and their step, queued work, pended decisions, blocked-on-user entries, and the last report log entry.
- Background jobs: if the harness exposes a background-job list, include id/status and the step it is on; otherwise write `not exposed by this harness`.
- Cross-check the state against `gh` in later sections: a state that names a PR as open when it is merged, or an agent as running when it is gone, is reported as stale state (one line, with the GitHub evidence).

### 2. Issues and board drift

```bash
for r in "$REPO" "$PIPE"; do
  gh issue list -R "$r" --state all  --limit 1000 --json number,state,title,labels,updatedAt,url
done | jq -s 'add' > "$BRIEF/issues.json"

gh project item-list "$PROJECT" --owner "$OWNER" --format json --limit 400 \
  --jq '.items[] | select(.content.type=="Issue") | {repo:.content.repository, number:.content.number, status, url:.content.url}' \
  | jq -s '.' > "$BRIEF/board.json"
```

Drift checks (each prints `status<TAB>url`; empty means none):

```bash
# open issues with no board item
jq -r -n --slurpfile b "$BRIEF/board.json" --slurpfile i "$BRIEF/issues.json" \
  '($b[0]|map(.url)) as $bu | $i[0][] | select(.state=="OPEN" and (.url as $u | ($bu|index($u)) == null)) | [.url,.title]|@tsv'

# closed issues still in a progress column (should be Done)
jq -r -n --slurpfile b "$BRIEF/board.json" --slurpfile i "$BRIEF/issues.json" \
  '($i[0]|map({key:.url,value:.state})|from_entries) as $st | $b[0][] | select($st[.url]=="CLOSED" and (.status=="In Progress" or .status=="In Review" or .status=="Verify")) | [.status,.url]|@tsv'

# open issues marked Done
jq -r -n --slurpfile b "$BRIEF/board.json" --slurpfile i "$BRIEF/issues.json" \
  '($i[0]|map({key:.url,value:.state})|from_entries) as $st | $b[0][] | select($st[.url]=="OPEN" and .status=="Done") | [.url]|@tsv'

# stale In Progress / In Review older than 3 days
jq -r -n --arg c "$CUTOFF_3D" --slurpfile b "$BRIEF/board.json" --slurpfile i "$BRIEF/issues.json" \
  '($i[0]|map({key:.url,value:.updatedAt})|from_entries) as $up | $b[0][] | select((.status=="In Progress" or .status=="In Review") and (($up[.url] // "9999") < $c)) | [.status,$up[.url],.url]|@tsv'
```

Counts to quote, never the full list:

```bash
jq -r '[.[]|select(.state=="OPEN")]|length' "$BRIEF/issues.json"
jq -r '.[]|select(.state=="OPEN")|[.labels[].name]|.[]' "$BRIEF/issues.json" | sort | uniq -c | sort -rn
jq -r 'group_by(.status)[] | "\(.[0].status // "(none)"): \(length)"' "$BRIEF/board.json"
jq -r '.[]|select(.state=="OPEN" and ([.labels[].name]|index("question"))) | [.number,.title,.url]|@tsv' "$BRIEF/issues.json"
```

Report: open counts by label (`bug`, `question`, `workflow`, `security`), board counts, then only drift items. Note when an open issue is an auto-created incident (`backup-failure`, `smoke-failure`, `security`) — those often skip the board by design; flag, do not treat every one as a manager lapse.

### 3. PR queue, CI, deploy

```bash
for r in "$REPO" "$PIPE"; do
  gh pr list -R "$r" --state open --limit 50 --json number,title,isDraft,reviewDecision,mergeable,updatedAt,url,headRefName,statusCheckRollup
done | jq -s 'add' > "$BRIEF/pr-open.json"

gh pr list -R "$REPO" --state merged --search "merged:>=$YDAY" --limit 100 \
  --json number,title,mergedAt,url,body > "$BRIEF/pr-merged.json"

for r in "$REPO" "$PIPE"; do
  gh run list -R "$r" --limit 40 --json databaseId,name,status,conclusion,createdAt,url
done | jq -s 'add' > "$BRIEF/runs.json"
```

Checks:

```bash
# draft / changes requested / conflicting / non-green checks
jq -r '.[] | select(.isDraft or .reviewDecision=="CHANGES_REQUESTED" or .mergeable=="CONFLICTING") | [.number,.isDraft,.reviewDecision,.mergeable,.url]|@tsv' "$BRIEF/pr-open.json"
jq -r '.[] | .number as $n | .statusCheckRollup[]? | select(.conclusion != "SUCCESS" and .conclusion != "NEUTRAL" and .conclusion != "SKIPPED") | [$n, (.name // .context), (.conclusion // .state)]|@tsv' "$BRIEF/pr-open.json"

# merged PR whose closing keyword names an issue that is still open
jq -r -n --slurpfile m "$BRIEF/pr-merged.json" --slurpfile i "$BRIEF/issues.json" \
  '($i[0]|map(select(.state=="OPEN")|.number)) as $open | $m[0][] | .number as $p | .url as $u | (.body // "") | scan("(?i)(?:closes|fixes|resolves) #([0-9]+)") | .[0] as $n | select(($n|tonumber) as $x | $open|index($x)) | [$p,$n,$u]|@tsv'

# queued/in-progress runs older than 30 minutes (CI queue stall)
jq -r --arg c "$CUTOFF_30M" '.[] | select(.status=="queued" or .status=="in_progress") | select(.createdAt < $c) | [.name,.status,.createdAt,.url]|@tsv' "$BRIEF/runs.json"
```

Deploy for main (run only for `$REPO`; pipeline deploy is section 5):

```bash
gh run list -R "$REPO" --workflow deploy.yml --branch main --limit 3 \
  --json databaseId,status,conclusion,headSha,createdAt,updatedAt,url
```

Report: open/draft count, changes-requested and conflicting PRs, failing/queued checks, the latest deploy (SHA + result + age), and any stall. A merged-but-open issue is drift: the PR should have closed it. Do not re-run checks or CI.

### 4. Nightly E2E

```bash
gh run list -R "$REPO" --workflow test-automation.yml --event schedule --limit 3 \
  --json databaseId,status,conclusion,createdAt,updatedAt,url,headSha > "$BRIEF/e2e.json"
RUN=$(jq -r '.[0].databaseId // empty' "$BRIEF/e2e.json")
```

With a run id:

```bash
gh run view "$RUN" -R "$REPO" --json jobs \
  --jq '.jobs[] | .name as $j | .steps[] | [$j,.name,.conclusion]|@tsv'

# only for a red run; strip both real ANSI and gh's caret form, then pull the failure lines
gh run view "$RUN" -R "$REPO" --log-failed 2>/dev/null \
  | sed -E 's/(\x1b|\^)\[\[?[0-9;]*[mK]//g' \
  | grep -aE 'FAIL .*integration|FAIL .*e2e|Test Files .*failed|Tests  .*failed|Tests failed|All tests passed|Running [0-9]+ tests using' | head -30
```

Interpret with the runner contract (`automation/docker/Dockerfile.test-runner` CMD chains the API integration suite **and** Playwright with `&&`):

- **Green** only when the `Run integration & E2E tests via Docker` step is `success` (that means both suites ran).
- **Red**: a `FAIL <project> <file> > <test>` line names a failing spec. If failures are in `automation/tests/local/api/...` and no Playwright result/summary appears, the **API integration suite failed first and E2E never ran** — report that explicitly; never call it an E2E failure.
- If the step is `skipped` or the run is queued, write `not checked — run <status>`.
- Duration trend: `(updatedAt - createdAt)` for the last 3 scheduled runs; name the last scheduled result and its age. A missing scheduled run in the window is `unknown — no scheduled run in the window`, not green.
- PR smoke subset: `grep -q -- '--smoke' automation/scripts/test-local.sh` → report that the local subset exists (`#660`) and whether `#657` has shipped a CI workflow (`gh issue view 657 -R "$REPO" --json state,url`). If no PR smoke workflow/run exists, write `not present` — do not run it.

### 5. Pipeline, VPS, freshness

```bash
gh run list -R "$PIPE" --workflow deploy-vps.yml --limit 3 \
  --json databaseId,status,conclusion,headSha,createdAt,updatedAt,url

gh run list -R "$PIPE" --status queued --limit 10 \
  --json databaseId,status,createdAt,url,name

gh run list -R "$REPO" --workflow smoke.yml --event schedule --limit 1 \
  --json databaseId,status,conclusion,createdAt,updatedAt,url
SMOKE=$(gh run list -R "$REPO" --workflow smoke.yml --event schedule --limit 1 --json databaseId --jq '.[0].databaseId')
[ -n "$SMOKE" ] && gh run view "$SMOKE" -R "$REPO" --json jobs \
  --jq '.jobs[].steps[] | select(.name|test("freshness|price";"i")) | [.name,.conclusion]|@tsv'
```

- Report the latest pipeline deploy (SHA + result + age) and any deploy run queued beyond 30 minutes (stall).
- **Freshness proxy**: the 6-hourly Production Smoke workflow runs `scripts/github/check-price-freshness.sh` with the ingest secret. Its `Check price-data freshness` step result is the pipeline freshness signal; a skipped step (secret unset) is `not checked`, never green.
- **Store failures, rejected/OCR items, run report**: `not checked — admin-gated` (published run reports are behind `GET /api/admin/price-runs`, cookie auth; #656/Y is still the credential decision). Do not run `scripts/vps-state.sh` (needs a sudo TTY) or read box env files.
- **Review-queue pending by reason**: `test -f scripts/review-queue-report.sh` and the credential already exported → run that read-only script; otherwise write `not checked — script absent / admin credential Y pending`. Never derive counts by guessing.
- **#116 sized-key/anchor**: `gh issue view 116 -R "$PIPE" --json state,title,closedAt,url`; cross-check the inbox V. If the issue is closed while V remains open, report V as a stale-inbox candidate (verify, do not run `repair-catalog.sh`).

### 6. Owner inbox — `docs/MANUAL_ACTIONS.md`

The file is owner-local and gitignored; in a worktree it is absent. Resolve it via the common git dir, which points at the main checkout:

```bash
COMMON=$(git -C "$REPO_DIR" rev-parse --path-format=absolute --git-common-dir)
MA="$(dirname "$COMMON")/docs/MANUAL_ACTIONS.md"
[ -f "$MA" ] || MA="$REPO_DIR/docs/MANUAL_ACTIONS.md"
[ -f "$MA" ] && echo "found $MA" || echo "not present in this checkout"
```

Parse IDs, age, and linked ticket (read only — never quote section bodies):

```bash
grep -nE '^## [A-Z]+\. ' "$MA" | sed -E 's/^([0-9]+):## ([A-Z]+)\. .*/\2\t\1/'

UPD=$(grep -oE '_Last updated [0-9]{4}-[0-9]{2}-[0-9]{2}' "$MA" | tail -1 | awk '{print $3}')
echo "inbox age: $(( ($(date -u +%s) - $(date -u -d "$UPD" +%s)) / 86400 ))d (updated $UPD)"

# open IDs named on the _Last updated line
grep -E '^_Last updated' "$MA" | grep -oE '\*\*[A-Z]+\*\*' | tr -d '*'

# first GitHub issue/PR link per ID, including the heading line: ID<TAB>url
awk '
  /^## [A-Z]+\. / {
    id=$2; sub(/\.$/,"",id)
    if (!seen[id] && match($0, /github\.com\/ahaqqu\/[A-Za-z0-9_-]+\/(issues|pull)\/[0-9]+/)) { print id"\t"substr($0,RSTART,RLENGTH); seen[id]=1 }
    next
  }
  id && !seen[id] && match($0, /github\.com\/ahaqqu\/[A-Za-z0-9_-]+\/(issues|pull)\/[0-9]+/) { print id"\t"substr($0,RSTART,RLENGTH); seen[id]=1 }
' "$MA" | while IFS=$'\t' read -r id url; do
    case "$url" in
      *"/pull/"*) st=$(gh pr view "https://$url" --json state --jq .state 2>/dev/null || echo unknown) ;;
      *)          st=$(gh issue view "https://$url" --json state --jq .state 2>/dev/null || echo unknown) ;;
    esac
    printf '%s\t%s\t%s\n' "$id" "$st" "$url"
  done
```

The loop above resolves each ID's first link read-only. Report:

- open IDs with the inbox age, ordered by impact (decisions that unblock issues first);
- each ID's linked ticket state; `CLOSED`/`MERGED` → **stale-inbox candidate — confirm and remove**, not automatically done;
- headings present but absent from the open list (e.g. a section whose sub-item was left behind) → stale section;
- `not present in this checkout` when the file cannot be found.

### 7. Contract sync

```bash
PIN=$(awk '!/^[[:space:]]*(#|$)/ { print; exit }' "$PIPE_DIR/contract/CONTRACT_SOURCE_SHA" 2>/dev/null)
LATEST=$(gh api 'repos/ahaqqu/RumaQ/commits?path=contract&per_page=1' --jq '.[0].sha')
[ -n "$PIN" ] && [ "$PIN" = "$LATEST" ] && echo "in sync $PIN" || echo "DRIFT pinned=$PIN latest=$LATEST"
```

- `in sync` only when the pinned 40-hex SHA equals the latest RumaQ commit that touched `contract/`.
- Drift means a contract change merged in RumaQ without a pipeline sync: flag it before the next pipeline deploy (`./scripts/sync-contract.sh <sha>` is a PR, never this skill).
- Optional byte-level proof: `(cd "$PIPE_DIR" && bash scripts/github/check-contract-sync.sh pinned)` — read-only. **Never run the `drift` mode**: it opens/updates an issue.
- Query failure or missing checkout → `unknown — contract SHA not readable`.

### 8. Local hygiene

```bash
df -BG / | tail -1
docker system df 2>/dev/null || echo "docker not checked — daemon unavailable"

for d in "$REPO_DIR" "$PIPE_DIR"; do
  [ -d "$d" ] || continue
  echo "== $d"
  git -C "$d" worktree list --porcelain | grep -c '^worktree '
  git -C "$d" worktree prune --dry-run -v 2>&1 | head -5
  cur=$(git -C "$d" branch --show-current)
  git -C "$d" branch --merged origin/main 2>/dev/null | sed -E 's/^[*+ ]+//' | grep -vx -e main -e "$cur"
done
```

Report: free disk (flag under 10% or 15 GB), Docker reclaimable images/volumes/build cache (flag over 10 GB), worktree counts, merged local branches that can be cleaned, and any permission-locked worktree. `prune --dry-run` is the only prune variant allowed — never remove worktrees, branches, images, or volumes here. Root-owned worktrees that need sudo are reported, never fixed.

### 9. Audit, Dependabot, backup, deploy guard

```bash
gh run list -R "$REPO" --workflow audit.yml  --limit 1 --json databaseId,status,conclusion,createdAt,url
gh run list -R "$REPO" --workflow backup.yml --limit 3 --json databaseId,status,conclusion,createdAt,updatedAt,url
gh issue list -R "$REPO" --state open --label security --limit 50 --json number,title,createdAt,url
gh issue list -R "$REPO" --state open --label backup-failure --limit 50 --json number,title,createdAt,url
gh api 'repos/ahaqqu/RumaQ/dependabot/alerts?state=open&per_page=100' \
  --jq 'group_by(.security_advisory.severity) | map({(.[0].security_advisory.severity): length}) | add // {}'
```

- **Red backup**: report the latest run, the open `backup-failure` issue, and the failing step's first error line (`gh run view <id> --log-failed 2>/dev/null | grep -aE 'FAILED \(|no such table|dump failed|##\[error\]' | head -5`). A failed backup is a red even though the last green run exists; never average it away.
- **Audit**: latest `audit.yml` result and age; open `security` issues; Dependabot counts by severity (critical/high first). API/auth failure → `unknown — Dependabot alerts unreadable`.
- **Deploy secret guard**: read the latest deploy run's `ci` job step `Run bash ./scripts/github/ci.sh` and the `Deploy production` step conclusions. A failure there is the guard/CI failure — do not run the guard locally.
- Do not paste advisory bodies or tokens; link the issue/run.

### 10. Decision hygiene

```bash
gh issue view 656 -R "$REPO" --json state,title,url                     # auto-mode evidence / credential Y
gh issue view 25  -R "$PIPE" --json state,title,url                     # Lotte source model / X
gh issue view 21  -R "$PIPE" --json state,title,url                     # identity epic (deferred)
gh pr list -R "$PIPE" --state open --limit 50 --json number,title,labels,url
```

- **Taxonomy approvals**: any open pipeline PR whose title/body touches the taxonomy is owner-approval-gated (pipeline `AGENTS.md`); surface it in Needs you now. None open → `none pending`.
- **#656 / Y**: if `scripts/review-queue-report.sh` or `scripts/review-evaluate.sh` is absent, auto-mode evidence is not available: report `#656 blocked on Y`, not a missing feature.
- **#25 / X**: the five Lotte decisions (X1 outlet scope, X2 price basis, X3 online source, X4 contract family, X5 mart + egress) are owner decisions; link the issue and the inbox X.
- **Owner questions not in the inbox**: open issues labeled `question` plus the manager state's `Blocked on user` entries. Flag any whose ID/number is absent from the `MANUAL_ACTIONS` headings — that is a question that would be lost.

## Output

One Markdown briefing, exact section order. Use counts and links; no raw tables, JSON, or command output.

```markdown
# Daily report — <YYYY-MM-DD HH:MM WIB>

Window: <since ...> · <n> repos · <n> open issues / <n> open PRs

## Needs you now

- [<what>](link) — <impact, ID, age>. ...

## Blocked

- [<what>](link) — <the exact blocker>. `not checked — <reason>` for missing auth/access.

## In flight

- [<PR/issue/agent>](link) — <current step, ETA/risk>. ...

## Green

- <verified pass since the window> — <count/timing>. ...

## Suggested next 3

1. <highest-leverage agent work, linked>.
2. ...
3. ...
```

Rules:

- **Needs you now**: owner decisions/actions with IDs and links, plus every red in the window (nightly, deploy, backup, audit, security) ordered by impact — data-safety/security first. Cap at 5; fold the rest into one "and N more" line with counts.
- **Blocked**: work that cannot progress without a decision/credential/owner step, and every `not checked`/`unknown` item with its reason. A red stays in Needs you now even when the only next step is the next scheduled run — do not bury it here.
- **In flight**: active agents/PRs/deploys and the current step; name stale state when GitHub contradicts it. Cap at 7.
- **Green**: only verified passes since the window (green deploy SHA, green nightly, green backup/audit, merges, contract sync). No "probably", no "last known". Include counts/timings.
- **Suggested next 3**: agent-doable, highest leverage, one line each, linked. Never owner decisions.
- **Never omitted**: a red nightly, failed deploy, failed backup, open `backup-failure`/`smoke-failure`/`security` issue, or a stale owner item. If the data could not be read, say so in Blocked.
- **Never included**: secret/token/cookie values, raw logs, full issue lists, `MANUAL_ACTIONS` section prose, or more than ~25 bullets total.
- Empty section: write `None.` Do not drop the heading.
- End with one line: `Sources: <checks that ran> · unknown: <failed queries>` so the reader knows what was not verified.

## Read-only proof

After a run, the checkout must be unchanged and GitHub must show no new/moved objects. When proving it, capture before/after counts (`open issues`, `open PRs`, `board items`) and `git status --porcelain` — they must match. The report must not include the proof unless the owner asks.
