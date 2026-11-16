# Audit — backend/src — 2026-11-16

Scope: `backend/src` at `origin/main` 251a724, clean worktree — 188 files, 30,605 lines of shipped source, 89 test files, 1,593 tests. Lens: all. Read-only: this file is the only change.

## Verdict

- **UX** — the screens cannot name what happened: one word (`failed`) covers three terminal causes, and a cancelled purge returns to the state the catalog renders as "never requested".
- **DX** — the rules that keep this backend safe are hand-copied per file: 6 `onError` bodies, 5 `NO_CACHE` definitions, 54 per-path auth mounts, 78 routes in one 7,247-line app.
- **AX** — the vocabulary is documented better than most repos, but two nouns are ambiguous (`failed`, `NULL`), so "what if the reaper fires mid-run" needs three modules and a constant from another repository.

## Ledger

ID | file:line | finding | why it matters | what instead
L1 | backend/src/lib/scrape.ts:53 | the 150/60-min ceilings encode the pipeline's configurable `RUN_DEADLINE_MS` (90 default) + 30 min, from another repo | raising that env var makes RumaQ reap live runs; their finish is then dropped at :338 while api.ts:594 still answers 200 | renew `heartbeat_at` on claim and on events; reap on silence (~45 min), not on age since claim
L2 | backend/src/apps/api.ts:562 | `GET /api/internal/scrape/next` claims a command | a retried poll (RFC 9110 §9.2.1: GET is safe) consumes a command no agent runs and blocks the one-at-a-time queue for the full ceiling | make the claim a POST, or return a claim token the finish must echo
L3 | backend/src/lib/price-runs.ts:150 | any stored status other than `success` is coerced to `failed`; the column has no CHECK (0010:11) | a hand-fixed or future value silently inflates the #536 dead-pipeline alarm | add the CHECK in a migration (0036 rebuilt a table for less) and delete the coercion
L4 | backend/src/lib/plugins.ts:214 | cancel sets `purge_state` and every provenance column to NULL | a withdrawal is indistinguishable from "never requested": the catalog reports null (:109), actor and time erased | add `cancelled` to the state set and write a receipt; at minimum keep `requested_by/at`
L5 | backend/src/lib/plugin-purge.ts:147 | budget exhaustion returns from the whole tick, not the current plugin | the second purge-capable plugin starves every night behind the first backlog (the file predicts it at :47) | break the household loop and continue with the next registration
L6 | backend/src/lib/plugin-purge.ts:205 | the dissolution drain loops `for(;;)` while the defeat path yields `objects: 0` | a mid-drain upload spins until the subrequest cap fails the invocation; the household cannot dissolve | cap chunks per invocation and return `complete: false` with the reason
L7 | backend/src/lib/plugins.ts:218 | the purge-active predicate is respelled at 8 sites (:218, :355; plugin-purge.ts:64; documents/lib.ts:557,634; documents/purge.ts:191,202,368; enablement.ts:165) | adding one state (L4) must find all 8 or a write path admits uploads mid-drain | one exported `PURGE_ACTIVE_SQL` and one `isPurgeActive()` in `plugins/enablement.ts`
L8 | backend/src/lib/tasks.ts:711 | the approve guard requires the stored `needs_approval = 1` that 0027:57-60 forbids trusting; reads derive it (:202) | the stored flag is the one thing the doc says must never decide approval | drop the flag predicate from both guards; the `EXISTS` join is the truth
L9 | backend/src/lib/tasks.ts:624 | a recurring task rolls forward and stays `open`, while approve (:707) requires `done` | `(recurrence, profile-only assignee)` is a legal row whose acknowledge step can never run | move approval to the completion record, or refuse the pair at create/assign
L10 | backend/src/apps/api.ts:388 | `onError` returns `err.message` for every error | D1/SQL text reaches clients, against BACKEND_CONVENTIONS.md:38; five sibling apps return fixed text (tasks.ts:157) | return fixed text and log `err`
L11 | backend/src/apps/api.ts:385 | six copies of `onError` (api:385, calendar:182, households:168, plugins:161, tasks:151, documents/app:410); auth has none | six edits per error-shape change, and one app answers Hono's default | one handler over a shared error base in `lib/`
L12 | backend/src/apps/api.ts:729 | auth is bound per exact path: 54 mounts, 0 wildcards, and Hono's `use()` covers no subpaths | a route added without its twin line ships unauthenticated; only a hand-enumerated test matrix (api-routes.test.ts:1471) notices | mount `propsAuthMiddleware` once for `/api/*` with an explicit public allow-list
L13 | backend/src/lib/ingest.ts:27 | `ingestPrices` (v1) is exported and tested (ingest.test.ts:343) but no route calls it; the live route uses ingest-v2.ts:476 | a dead engine keeps ~400 test lines green and hides which payload version ships | delete the v1 function and its tests, or rename the module to the capability it serves
L14 | backend/src/lib/plugin-cron.ts:49 | the cron driver is unreachable: no manifest declares `cronTasks` (manifests.ts:136 validates none) | dead seam with tests; the first real task inherits an unexercised contract | delete until a manifest declares one, or ship one real task

## Machines

### M1 — the scrape command lease — `backend/src/lib/scrape.ts:53`

```
BEFORE (implicit)                        AFTER (explicit lease)
pending ─claim→ running ─finish→ ok     pending ─claim→ running ─finish→ ok
  │reap 60m      │reap 150m               │reap 60m      │silent 45m
  ▼              ▼                       ▼              ▼
failed         failed  (3 causes)      reaped         reaped  (terminal, cause named)
                                        running ─event→ running  (heartbeat renewed)

from    | event  | guard                                          | to        | effect
pending | claim  | status='pending'                               | running   | set picked_up_at, heartbeat_at
running | event  | status='running'                               | running   | set heartbeat_at
running | finish | status='running'                               | ok/failed | set finished_at, exit_code
pending | reap   | created_at < now-60m                            | reaped    | set reason
running | reap   | coalesce(heartbeat_at, picked_up_at) < now-45m | reaped    | set reason, exit_code NULL
```

Migration map: `error LIKE 'reaped:%'` → `reaped`; unknown value → `failed`, which the 0012:13 CHECK keeps unrepresentable.
Proof: scrape-sql.test.ts:241 (the exact-ceiling boundary) stays green with the ceiling renamed; new — events renew the lease, a silent row reaps, a finish after reap answers 409.
UX + (the monitor says "reaped — agent silent"), DX + (one ceiling, no constant from another repo), AX + (one greppable cause). **decision: M1 adopt.**

### M2 — the purge lifecycle — `backend/src/lib/plugins.ts:214`

```
BEFORE                                    AFTER
none ─initiate→ pending ─claim→ running    none ─initiate→ pending ─claim→ running
  ▲                  │cancel                 ▲                 │cancel   │complete
  └──── NULL ────────┘                      │                 ▼         ▼
   (request + actor erased)                └──(no row)    cancelled     done
                                                            └─initiate→ pending

from            | event    | guard                 | to        | effect
none            | initiate | no row                | pending   | set requested_by/at
pending         | claim    | purge_state='pending' | running   | —
running         | complete | zero docs left        | done      | receipt once
pending/running | cancel   | active                | cancelled | set completed_at, reason
cancelled       | initiate | terminal              | pending   | new run
```

Migration map: no existing row can be `cancelled` (the lever nulls it), so pre-change cancellations are unrecoverable — report them as `none`, never guess.
Proof: plugin-purge.test.ts:1106 stays green with `cancelled` expected; new — the catalog names the withdrawal, and a re-initiate after a cancel drains only new data.
UX + (the catalog has a state for it), DX + (one terminal set; L7's 8 predicates collapse), AX + (`NULL` stops meaning two things). Cost: one 0035 rebuild plus one 0032 vocabulary rebuild. **decision: M2 adopt** — state first, the receipt rides the same rebuild.

### M3 — task approval — `backend/src/lib/tasks.ts:624`

```
BEFORE (status × flag × approver)          AFTER (approval per completion)
open ─complete(one-shot)→ done ─approve→   open ─complete→ open + completion(awaiting)
open ─complete(recurring)→ open (roll)       completion ─approve→ completion(approved)
  (recurrence ⇒ never `done` ⇒ the kid's     (recurrence no longer excludes approval)
   chore can never be acknowledged)

from       | event                | guard                            | to       | effect
open       | complete (one-shot)  | status='open' AND due_date IS ?  | done     | approval opens
open       | complete (recurring)| same anchor                     | open     | append completion row
done       | approve              | needs_approval AND status='done' | done     | set approved_by
completion | approve              | awaiting                        | approved | set approver on completion
```

Migration map: existing `done` rows become one approved completion each; recurring rows have no completion history to migrate — say so in the header.
Proof: tasks.test.ts (complete/approve) stays green for one-shot; the recurring acknowledge is a deliberate new behaviour with its own test.
UX + (the parent can acknowledge a recurring chore), DX − (a new table and endpoint), AX + (a completion is a row, not a status). **decision: M3 defer** — ship L9's guard now; the redesign needs a product decision on what an allowance credits.

## Docs

ID | file:line | claim | tested | verdict | replacement
D1 | docs/ARCHITECTURE.md:211 | "The Worker returns signed URLs" | false — receipts.ts:163 returns null; the same file says proxy at :592 and :640 | rewrite | "receipt images stream through the Worker proxy; no signed URLs"
D2 | docs/TEST_STRATEGY.md:11 | backend unit row: "D1 mocked" | false — suites run node:sqlite with real migrations (support/d1-sqlite.ts) | rewrite | "real SQLite (node:sqlite), migrations applied"
D3 | docs/BACKEND_CONVENTIONS.md:7 | "one app per domain, wired through the gateway" | mixed — 6 apps do; api.ts keeps 78 of 116 routes in 7,247 lines | rewrite, then split | name the pending split and a route budget, link the issue
D4 | docs/BACKEND_CONVENTIONS.md:13 | "Valibot for all request inputs: params, query, body" | mixed — 33 of 78 api.ts routes, 0 of 5 auth routes | rewrite | "wherever an input schema exists, params and query included"
D5 | docs/BACKEND_CONVENTIONS.md:32,37 | shared cache and error helpers | false — 6 `onError` copies, 5 `NO_CACHE` definitions, dozens of inline literals (api.ts:387+) | keep rule, fix code | L11, plus one `NO_CACHE` export from `lib/request.ts`
D6 | docs/BACKEND_CONVENTIONS.md:38 | "do not expose raw internal error messages" | false — api.ts:388 returns `err.message` | keep rule, fix code | L10
D7 | docs/BACKEND_CONVENTIONS.md:15,53 | env validation at startup; security-header middleware | false — Workers has no startup, and no CSP/XFO exists (only nosniff, documents/app.ts:881) | rewrite as open items | "validate at first use, fail closed"; "security headers: not shipped, #<issue>"

## Comments

ID | file:line | claim | tested | verdict | replacement
C1 | backend/src/lib/plugins.ts:416 | "the catalog's state line is the visible trace" | false — cancel nulls the state (:214) and `purgeInfoOf` maps NULL to null (:109) | disagree | write the receipt (L4), or delete the sentence
C2 | backend/src/lib/price-runs.ts:148 | "the contract's picklist keeps the column to exactly those two" | false for the column — 0010:11 has no CHECK; only the ingest body is validated | rewrite | "no DB constraint; the ingest schema guards the only writer, and this narrows unknown values"
C3 | backend/src/lib/scrape.ts:41 | 150 min = the pipeline's 120-min child timeout plus slack | true at HEAD (pipeline deadlines.ts:58, agent.ts:175) but `RUN_DEADLINE_MS` is env-configurable | rewrite | name the knob and the failure mode; L1 removes the coupling
C4 | backend/src/lib/plugin-purge.ts:154 | "it retries next tick" | false for `PluginPurgeCancelledError` — the chunk refuses forever | rewrite | branch on the error type before logging
C5 | backend/src/plugins/enablement.ts:119 | fail-closed enforcement vs fail-open advertisement | true — flags.ts:56,74 and enablement.ts:134-139 | keep | —

## Verification

`neither`. The harness reaches every audited surface (vitest + node:sqlite + migrations + worker smoke), and the invariants that matter are SQL-level: at most one live command (scrape.ts:202) and never "drained" with documents left (purge.ts:280) are single-statement guards inside a D1 batch, already pinned against real SQLite; a model checker would model D1's serialization, not this code. The proof still missing is cheaper than either tool: a contract-level ceiling constant plus a test asserting `RUN_DEADLINE_MS + headroom < ceiling` (target scrape.ts:53; it makes L1's live-run reap unrepresentable). Second target: iterate the registered route table and assert 401 for every non-public path (target api.ts:729), turning L12's convention into a test.

## Issues

ID | title | recommendation next step
M1 | Scrape command lease: heartbeat and a named `reaped` state | adopt
M2 | Purge lifecycle: an explicit `cancelled` state and receipt | adopt
M3 | Approval per completion, not per task status | defer
L1 | Reaper ceilings encode another repo's configurable deadline | implement
L2 | Scrape claim is a mutating GET | implement
L3 | `price_runs.status` has no CHECK and is silently coerced | implement
L4 | Purge cancel erases the request and its actor | implement
L5 | Purge tick budget starves later plugins | defer
L6 | Dissolution drain can spin to the subrequest cap | defer
L7 | Purge-active predicate respelled at 8 sites | implement
L8 | Approve guard trusts the stored `needs_approval` flag | implement
L9 | Recurring task with a profile-only assignee can never be approved | implement
L10 | `api.ts` onError leaks internal error text | implement
L11 | Six copies of the error handler | implement
L12 | Auth bound per route path with no wildcard | defer
L13 | Dead v1 ingest engine kept alive by its tests | implement
L14 | Unreachable plugin cron driver | implement
D1 | ARCHITECTURE claims signed receipt URLs | implement
D2 | TEST_STRATEGY claims a mocked D1 | implement
D3 | Conventions claim one app per domain; api.ts holds 78 routes | implement
D4 | Conventions claim Valibot on every input; 45 api.ts routes skip it | implement
D5 | Conventions claim shared cache and error helpers | implement
D6 | Conventions claim no raw error messages | implement
D7 | Conventions mandate security headers that do not exist | defer
C1 | Purge-cancel comment claims a trace the code erases | implement
C2 | price_runs comment claims a constraint the schema lacks | implement
C3 | Reaper comment cites a configurable default as a constant | implement
C4 | Purge tick logs a retry that cannot happen | implement
C5 | Enablement fail-closed comment | drop
