# Audit — frontend/src — 2026-11-16

Scope: `frontend/src` at `origin/main` 251a724, clean worktree — 192 files (117 `.jsx`, 67 entry
`.js`, 8 `.ts`), 25 pages, 21 components, 20 query modules, 74 test files / 986 cases. React 18 +
Vite + TanStack Query/Router + Tailwind + i18n (en/id). Lens: all. Read-only: this file is the only
change.

## Verdict

- **UX** — the app cannot say _why_ it has no data: six pages paint an empty state on a failed
  query, eleven panels call a 500 "offline", and a cold boot paints a blank page then the login
  wall for a signed-in user.
- **DX** — the conventions hold (query hooks, shared UI components, en/id parity 1005/1005), but the
  pieces that must move together are loose: two Rupiah formatters, four clock formatters, one
  member cache key spelled six times.
- **AX** — "what happens offline" has no greppable answer: there is no offline state to search for,
  so the answer lives in `unwrap`'s absence of a catch plus five page branches.

## Ledger

ID | file:line | finding | why it matters | what instead
L1 | frontend/src/lib/api.ts:207 | logout awaits the POST but never checks `res.ok`; `fetch` resolves on 403/500 | "logging out" navigates home while the cookie and session epoch survive | treat non-2xx as a failed logout; only the transport fallback may retry via GET
L2 | frontend/src/lib/api.ts:156 | `unwrap` has no catch: a transport failure escapes as a `TypeError`, not an `ApiError` | offline is unrepresentable, so every `instanceof ApiError` branch (Documents.jsx:50, ProductRenameForm.jsx:71) misses it | `ApiError.from(err)` with `status: 0` and a `kind: 'offline' │ 'http' │ 'timeout'` (M1)
L3 | frontend/src/routes/__root.jsx:18 | the root gate paints `null` while loading and `Login` whenever `me?.user` is absent | a cold offline or 5xx load shows the login wall to a signed-in user, after a blank page | paint a shell for the hydrating state and a distinct "unreachable" state (M3)
L4 | frontend/src/pages/Documents.jsx:894 | the list paints its empty state with no error branch (0 `isError`); same in Tasks:394, Calendar:544, Home, Plan, Inventory | a failed query tells the user their data does not exist | add the error branch History (3 `isError`) and AdminReview (5) already have
L5 | frontend/src/pages/AdminPrices.jsx:410 | error panels reuse `offline.banner` as the description (ProductsView:409 and 9 more) | a 500 tells the user they are offline, so they try the wrong fix | one i18n key per error kind, fed by M1
L6 | frontend/src/lib/queries/review.js:119 | the optimistic decide patches `items` only, while the header paints `counts` and `filteredTotal` (AdminReview.jsx:809) | the pending badge contradicts the visible rows until the settle refetch; `decidedBy: null` blanks the actor chip | patch the derived counts in the same `setQueryData` (M2)
L7 | frontend/src/context/AppContext.jsx:6 | a retired plaintext AI key is read and written from `localStorage`, and Assistant.jsx:70 ORs it into "connected" | the dot claims a working provider when no request carries the key (api.ts:288); the secret sits in JS-readable storage for nothing | delete `rumaq_ai_key` on load; derive connected from `ai_status` alone
L8 | frontend/src/lib/queries/me.js:40 | `queryClient.clear()` runs before `await apiLogout()` | a failed logout drops the whole cache and the running mutation, then leaves the session live | clear in `onSuccess` — a 401 already nulls `['me']`
L9 | frontend/src/lib/household-money.js:15 | `formatHouseholdMoney` re-implements `pricesHelpers.js:206` line for line | one currency, two formats; the drift the comment calls "the #292 precedent" already happened once | import `formatPrice`, or move both to `lib/money.js`
L10 | frontend/src/components/RoutePending.jsx:4 | exported, imported by nothing; no route declares `pendingComponent` | the documented route-level loading state does not exist, and the component ships untested | wire it as the root `pendingComponent`, or delete it
L11 | frontend/src/components/RouteError.jsx:19 | `t('error.title', 'Something went wrong')` with the fallback inline; `error.*` is in neither locale | the crash screen is English in Indonesian and nothing notices the missing keys | add `error.*` to en/id, drop the inline defaults
L12 | frontend/src/lib/queries/households.js:103 | `['household-members', id]` is respelled at :117, :132, :136, :149, :178 | one key-shape change silently orphans five invalidations (TanStack fails quietly) | export `MEMBERS_KEY(id)` and import it

## Machines

### M1 — the request outcome — `frontend/src/lib/api.ts:156`

```
BEFORE (two shapes, one unhandled)         AFTER (one classifier)
ok        -> data                          http    -> ApiError(status, retryAfter, message)
4xx/5xx   -> ApiError(status, ...)         offline -> ApiError(0, null, offlineCopy)
offline   -> TypeError  (uncaught)         timeout -> ApiError(0, null, timeoutCopy)
aborted   -> AbortError (filtered)         aborted -> rethrow, never painted

state   | event            | guard             | to      | effect
idle    | request          | —                 | pending | isPending paints
pending | response ok      | response.ok       | success | data, isError false
pending | response 4xx/5xx | !response.ok      | http    | status + Retry-After kept
pending | transport reject | not an ApiError   | offline | status 0, offline copy
pending | abort            | signal.aborted    | idle    | never painted as an error
```

Migration map: `unwrap` wraps its await in `try/catch` and throws `ApiError.from(err)`; the 12 `instanceof ApiError` branches keep working, and those needing `kind` gain it. An unknown throw maps to `kind: 'http', status: 0`, never to offline.
Proof: `api.test.js` (774 lines) pins the current throw shapes and stays green; new — a rejected fetch, an aborted request, a 500 that is not labelled offline.
UX + (six pages gain a truthful error state), DX + (one classifier), AX + (`kind` is greppable). **decision: M1 adopt.**

### M2 — the optimistic decision — `frontend/src/lib/queries/review.js:119`

```
BEFORE (row only)                         AFTER (row + derived slices)
items[i].status = next                    items[i].status = next
counts.pending  (unchanged)  <- lie       counts[from]--, counts[to]++, filteredTotal--
filteredTotal   (unchanged)  <- lie       decidedBy = caller, decidedAt = none
chip contradicts rows until settle        chip and rows agree from the first frame

from    | event  | guard                | to       | effect
pending | decide | item.id === vars.id  | approved | row flips, counts move, actor set
pending | undo   | item.id === vars.id  | pending  | row returns, counts return
any     | reject | onError has snapshot | previous | full snapshot restore
any     | settle | invalidate review   | server   | server state wins
```

Migration map: one `patchReviewCaches(queryClient, vars)` used by decide and undo; it already loops every filter key, so a page without counts is unchanged.
Proof: `review.test.js` (394 lines) pins the row flip and the rollback; the new assertion is the count delta and the actor chip.
UX + (the badge stops lying), DX + (one patch function), AX + (the optimistic write is one place). **decision: M2 adopt.**

### M3 — the app boot — `frontend/src/routes/__root.jsx:18`

```
BEFORE (three states, two painted)        AFTER (four named states)
hydrating   -> null                        hydrating     -> shell + skeleton (cached data as data)
authed      -> app                         authenticated -> app
anon        -> Login                       anonymous     -> Login
unreachable -> Login (wrong)               unreachable   -> shell + "can't reach the server"

state       | event            | guard                   | to
hydrating   | persisted cache  | PersistQueryClient      | authenticated | anonymous
hydrating   | /api/me resolves | me?.user                | authenticated
hydrating   | /api/me rejects  | MeError, retry: false   | unreachable
unreachable | retry            | refetch                 | authenticated | anonymous
anonymous   | login            | —                       | authenticated
```

Migration map: `me.js` returns null on 401 (anonymous) and throws otherwise (unknown); the gate maps `isError && !isLoading` to `unreachable`. The persisted cache shape does not change.
Proof: the root gate has no test; the new one drives a rejected `/api/me` and asserts the shell, not the login wall. The offline promise at UI_FEATURES.md:131 depends on this state.
UX + (offline is a state, not a logout), DX − (one branch in the gate), AX + (four states named). **decision: M3 defer** — ship M1 first; the banner copy and shell are the owner's call.

## Docs

ID | file:line | claim | tested | verdict | replacement
D1 | docs/FRONTEND_CONVENTIONS.md:44 | "use the project's provider wrapper for component tests" | false — 45 test files call `render()` directly; the one `renderWithProviders` is local (AppShell.test.jsx:77); providers are globally mocked (test-setup.js:40) | rewrite | "Providers are mocked globally in `src/test-setup.js`; call `render()` directly."
D2 | docs/UI_FEATURES.md:130 | "error with retry" for every async area | false — six pages have no error branch and no page offers a retry control | rewrite | "loading and empty per area; error only where the page branches on `isError` (History, AdminReview)"
D3 | docs/UI_FEATURES.md:134 | "two languages for all text" | mixed — en/id parity is 1005/1005, but `error.*` is missing (RouteError.jsx:19) and AddFromReceipt.jsx:417 has three English literals | rewrite | name the crash screen and the three receipt labels as the exceptions, or fix them
D4 | docs/TEST_STRATEGY.md:10 | frontend tests are one jsdom project at 50/50/50/50 | mixed — thresholds hold (vite.config.js:204), but a second `frontend-dom` project exists for api.test.js (vite.config.js:160) | rewrite | "two jsdom projects: `frontend` (vmThreads) and `frontend-dom` (forks)"
D5 | README.md:28 | the frontend stack includes "Kumo UI" | mixed — `@cloudflare/kumo` supplies CSS tokens only; all 21 components are hand-rolled | rewrite | "hand-rolled components on Kumo design tokens"
D6 | docs/UI_FEATURES.md:131 | offline changes survive and sync | true — paused mutations are dehydrated by the persister and resumed (`resumePausedMutations`, __root.jsx:59; queryClient.js:20-40) | keep | —

## Comments

ID | file:line | claim | tested | verdict | replacement
C1 | frontend/src/lib/queries/products.js:30 | "No staleTime" | false — the query inherits the 5-minute default (queryClient.js:11) | rewrite | "staleTime: 0 — the optimistic metadataVersion must come from the newest read"
C2 | frontend/src/lib/api.ts:210 | a failed logout POST falls back to the GET navigation | false for HTTP errors — a 500 does not throw, so the fallback never runs (L1) | delete | check `res.ok`; keep the fallback for transport only
C3 | frontend/src/plugins/context.jsx:25 | the advertisement fails open while the backend gate enforces | true — null set ⇒ every entry enabled; the server answers 404 | keep | —
C4 | frontend/src/lib/queries/me.js:4 | a 401 resolves to null; network failures throw so offline keeps the cached shell | true — `fetchMe` at :9 | keep | —
C5 | frontend/src/components/Assistant.jsx:64 | the pre-split browser key "still counts until P5 removes that path" | true as written, but the cost is a false "connected" dot and a stored secret (L7) | disagree | remove the path now
C6 | frontend/src/lib/queries/review.js:100 | every `['review']` query invalidates on settle so server state wins | true, but only on settle — the optimistic patch omits counts (L6) | rewrite | name the omission, or patch the counts (M2)

## Verification

`neither`. The harness reaches the surface (Vitest + jsdom + Testing Library, 74 files / 986 cases,
`frontend-dom` for the client), so no new tooling is owed. What is missing is one test matrix the
harness already supports: mount each page with a rejected query and assert the error surface, plus
a single test for the boot gate's `unreachable` state (target `__root.jsx:18`). Both are ordinary
tests; the audit's ledger is what says which pages are unpainted.

## Issues

ID | title | recommendation next step
M1 | One request-outcome classifier with an offline kind | adopt
M2 | Optimistic review decision patches its counts | adopt
M3 | Boot gate: hydrating, authenticated, anonymous, unreachable | defer
L1 | Logout ignores non-2xx responses | implement
L2 | `unwrap` leaves transport failures unclassified | implement (rides M1)
L3 | The root gate turns "unknown" into the login wall | implement (rides M3)
L4 | Six pages paint empty on a failed query | implement
L5 | Eleven error panels call a 500 "offline" | implement (rides M1)
L6 | The optimistic review flip leaves the counts stale | implement (rides M2)
L7 | A retired AI key is stored and reported as connected | implement
L8 | Logout clears the cache before the request | implement
L9 | Two Rupiah formatters for one currency | implement
L10 | `RoutePending` is dead and no route has a pending state | implement
L11 | The crash screen is English in both locales | implement
L12 | The member cache key is respelled five times | implement
D1 | Conventions name a provider wrapper that does not exist | implement
D2 | UI_FEATURES promises error-with-retry everywhere | implement
D3 | UI_FEATURES promises all text translated | implement
D4 | TEST_STRATEGY misses the second frontend project | implement
D5 | README calls the stack Kumo UI | implement
D6 | UI_FEATURES' offline-and-sync promise | drop
C1 | products.js "No staleTime" comment | implement
C2 | logout fallback comment | implement (rides L1)
C3 | plugin fail-open comment | drop
C4 | me.js 401 comment | drop
C5 | Assistant legacy-key comment | implement (rides L7)
C6 | review settle-invalidation comment | implement (rides M2)
