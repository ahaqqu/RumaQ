# Plugin architecture — core + adapters for optional features (document vault = first plugin)

> Status: **DRAFT for owner review** (ahaqqu/RumaQ#400) — design only, no implementation in
> this ticket. Written 2026-11-04. The owner directive this document answers: *"the goal of
> rumaq is super app for managing home/house. not all customer want to use all of these
> features. so i think we should has concept plugin. for example storing document is a
> plugin. customer can choose not to use this feature. in future if i want to change this
> document plugin to something else (e.g. google drive) this should be easy and not breaking
> the core function. so we should has concept core and adapters. where plugin talks to
> adapters rather than code."*
>
> Two persona sections below are the deliverable: **§3 Perspective: Product Manager** and
> **§4 Perspective: Product Architect**. They are written to be readable independently —
> the PM section makes no assumptions about code, the architect section references real
> files. In-flight work is explicitly unaffected: the document-vault MVP (PR #399/#388)
> ships as-is, and its `StorageAdapter` (`backend/src/lib/storage.ts`) is already the first
> adapter seam — this design builds on it and never discards it. When implementing the
> follow-up tickets (§7), follow the `guided-implementation` skill.

## 0. Background

- RumaQ is a super app for household management: inventory, shopping plans, price
  explorer, receipt scanning, household members, document vault, admin surfaces. Not every
  household wants every surface — the document vault holds precisely the most sensitive
  artifacts a family has (KTP, kartu keluarga, akta), and some customers will rationally
  not want that data stored at all.
- Today, "optional" is expressed only in the frontend nav (`frontend/src/components/
  AppShell.jsx` hard-codes `NAV` / `HOUSEHOLD_ADMIN` groups) and in the gateway's
  hand-wired dispatch (`backend/src/gateway.ts` adds one `if` per domain app). Feature
  presence is a **code layout fact**, not a **product fact** a household controls.
- The vault MVP already contains the two structural pieces this design generalizes:
  - an **adapter seam**: `StorageAdapter` (`backend/src/lib/storage.ts`, put/get/delete over
    private R2 via the `DOCUMENTS` binding in `cloudflare.config.ts`),
  - a **domain app**: `backend/src/apps/documents.ts` dispatched by prefix in `gateway.ts`,
    with the `documents`/`document_audit` tables from migration `0022`.

The question #400 asks: make *feature* and *implementation* both swappable — features
enable/disable per customer without breaking core, and implementations (R2 → DokumenQ →
"Google Drive") swap behind typed ports without breaking features.

## 1. Prior-art survey

Seven established plugin systems, surveyed for the four axes that matter here: boundary
style, enablement granularity, lifecycle, and permission model.

| System | Boundary | Enablement granularity | Lifecycle | Permissions / trust |
|---|---|---|---|---|
| **Home Assistant** | In-process integrations; entities | Per **config entry** (≈ per instance of an integration, per home) | `setup → setup_entry → unload_entry → remove`; reload/disable **without restart** | No sandbox — integrations are trusted core code, gated by review |
| **Obsidian** | In-process, full API access | Per **vault** (per workspace of files) | Install → enable/disable per vault; "Restricted mode" kills all | Manifest declares nothing enforceable; **no permission system** — enabled = full access |
| **VS Code** | In-process extension host | Global default + **per workspace** override | Manifest + `contributes` (declared UI) + activation events (lazy load); disable = never activates | Declarative capability contributions; marketplace trust, no runtime ACL |
| **WordPress** | In-process hooks (actions/filters) | Per site install (enable/disable) | Activate/deactivate; uninstall may orphan data | **None effective** — plugins are the majority of WP vulnerabilities; hooks can reach everything |
| **Backstage** | Frontend: build-time composed packages; backend: separate deployables | Per **app build** (install = compose) + per-user feature flags on top | Install at build time; feature flags toggle visibility at runtime | npm/dependency trust; no per-plugin capability grants |
| **Strapi** | In-process npm packages | Per deployment via `config/plugins.js` (`enabled: false`) | Install (npm) → enable/disable in config; data often survives uninstall unmanaged | Config-file trust; no user-facing permission model |
| **Grafana** | Frontend + backend plugin processes | Per instance config (`plugins.<id>.disable`), per-dashboard exposure | `plugin.json` manifest scanned at startup; signing gate; provisioning | **Signature verification** (trust gate before load); RBAC on top |

Sources: [HA config entries](https://contributors.home-assistant.io/core/integrations/config-entries),
[HA config-entry unloading quality scale](https://contributors.home-assistant.io/core/quality-scale/config-entry-unloading),
[HA config-entry state transitions](https://contributors.home-assistant.io/blog/2025/02/19/new-config-entry-states),
[Obsidian plugin security](https://obsidian.md/help/plugin-security),
[Obsidian community plugins](https://obsidian.md/help/community-plugins),
[VS Code activation events](https://code.visualstudio.com/api/references/activation-events),
[VS Code extension manifest](https://code.visualstudio.com/api/references/extension-manifest),
[WordPress plugin handbook — hooks](https://developer.wordpress.org/plugins/hooks/),
[Wordfence on WP request architecture & hooks](https://www.wordfence.com/blog/2024/07/wordpress-security-research-series-wordpress-request-architecture-and-hooks/),
[Backstage frontend system architecture](https://backstage.io/docs/frontend-system/architecture/index/),
[Backstage frontend plugins](https://backstage.io/docs/frontend-system/architecture/plugins/),
[Strapi plugins configuration](https://docs.strapi.io/cms/configurations/plugins),
[Grafana plugin.json reference](https://grafana.com/developers/plugin-tools/reference/plugin-json/),
[Grafana anatomy of a plugin](https://grafana.com/developers/plugin-tools/key-concepts/anatomy-of-a-plugin/).

### 1.1 Synthesis — what RumaQ should adopt vs avoid

**Adopt:**

1. **Build-time composition, runtime enablement** (Backstage, Strapi, Grafana): plugin code
   ships in the monorepo bundle; *enablement is data, not code loading*. This is also the
   only option on Cloudflare Workers — the runtime forbids `eval()`/`new Function()` and
   requires all code uploaded at deploy time ([Cloudflare Workers restrictions](https://blog.cloudflare.com/workers-vitest-integration/)).
2. **Config-entry-style per-tenant lifecycle** (Home Assistant): enablement is a **row with
   a state machine** (enabled/disabled + timestamps), teardown/re-enable without restart,
   and an explicit data-removal step separate from disable. HA's config entry is the
   closest prior art to what a RumaQ household needs.
3. **Declared UI contributions** (VS Code `contributes`, Grafana `plugin.json`): a plugin
   *declares* its nav entries, routes, and settings panels; core renders them only when
   enabled. Nothing reaches into `AppShell.jsx` imperatively.
4. **Startup manifest validation** (Grafana): manifests are validated by a test/CI step, so
   a malformed plugin fails the build, never the runtime.
5. **Ports, not hooks** (the healthy half of every system above): plugins depend on narrow
   typed interfaces owned by core, never on core internals.

**Avoid:**

1. **WordPress's hooks-and-filters bus.** Unbounded reach into core and sibling plugins is
   exactly why WP plugins dominate its vulnerability reports and why WP upgrades are
   feared ([Wordfence](https://www.wordfence.com/blog/2024/07/wordpress-security-research-series-wordpress-request-architecture-and-hooks/)).
   RumaQ wants *swappable seams* with a single consumer each, not an interception mesh.
2. **Obsidian's "no permission model" shortcut.** Enabled = full access is survivable for
   a local text editor; for a multi-tenant server holding family identity documents it is
   not. Capabilities stay declared in the manifest and checked.
3. **Runtime code loading / marketplace dynamics.** Not possible on Workers (no eval, all
   code at deploy time), and a third-party plugin marketplace is a trust regime RumaQ does
   not need while all plugins are first-party monorepo code.
4. **Microservice-per-plugin** (Backstage's backend pattern, Strapi-style service
   isolation): rejected for RumaQ's scale — see §5.

## 2. Vocabulary: core, plugin, port, adapter

One diagram, four words. This is the whole architecture; everything after this section is
consequence.

```
┌─ core (never feature-aware) ──────────────────────────────────────────────┐
│  auth + active-household resolution (propsAuthMiddleware, ACTIVE_HOUSEHOLD_SQL) │
│  plugin registry (manifests, validation)   household_plugins (enablement rows)  │
│  gateway dispatch by registered prefix     cron handoff     audit facility      │
│  i18n namespaces      rate limits      error envelope      contract codegen    │
└───────┬────────────────────────────────────────────────────┬───────────────┘
        │ plugin calls core ONLY through ports               │ core calls plugins
        ▼                                                    ▼ only via declared
┌─ plugins (features) ──────────────┐  ┌─ ports (typed contracts) ─┐  surfaces
│ documents (the vault, ex-apps/    │  │ StorageAdapter (exists)   │
│ documents.ts)  … future plugins   │─▶│ Notifications, AI/OCR, …  │
│ own: routes, tables, i18n keys,   │  └──────┬────────────────────┘
│ nav entries, settings panel       │         ▼
└───────────────────────────────────┘  ┌─ adapters (implementations) ─┐
                                       │ R2 private bucket (today)    │
                                       │ DokumenQ HTTP client (#391)  │
                                       │ "Google Drive"-style (hyo)   │
                                       └──────────────────────────────┘
```

- **Core** — everything a household cannot opt out of: auth, households/members, the
  plugin registry, contract codegen, deploy plumbing. Core knows *which plugins exist*
  (it must, to dispatch) but has **zero feature logic** for any of them.
- **Plugin** — an optional feature: routes, tables, i18n keys, nav entries, settings.
  Talks **only to ports and its own code**. Never imports another plugin, never touches
  core tables directly.
- **Port (adapter interface)** — a typed contract core owns and plugins consume.
  `StorageAdapter` is port #1; it already exists in exactly this role.
- **Adapter** — an implementation of a port. Swapping R2 → DokumenQ (#391) → a
  Google-Drive-style service changes **one adapter file**, not the plugin, not core —
  the owner's requirement verbatim.

The critical separation the owner asked for: *"customer can choose not to use this
feature"* is the **plugin** axis (enablement); *"change this document plugin to something
else (e.g. google drive)"* is the **adapter** axis (implementation swap). They are
orthogonal. A Google Drive adapter would swap what *stores the bytes*; it does not disable
the vault feature.

## 3. Perspective: Product Manager

### 3.1 User value

- **A super app that respects choice.** Households come for groceries and inventory; the
  document vault is intimate. Making it a plugin means a household that never asked for
  private-document storage never sees it, never wonders what it does with KTP scans, and
  never carries the cognitive load of an unused surface in nav or settings.
- **Trust as a feature.** "Disable" is a visible, reversible commitment that *your
  household's data is not being kept*. For Indonesian family documents (identity papers),
  the ability to turn the vault off — and to export-then-purge — is a differentiator, not
  a concession.
- **Owner velocity.** The same structure lets the owner replace implementations (self-host
  DokumenQ per #391) or retire/replace whole features without destabilizing what
  households rely on daily.

### 3.2 What "customer chose not to use this plugin" means concretely

For a household with the documents plugin **disabled**, every one of these is true:

| Surface | Disabled experience |
|---|---|
| Nav | No Documents entry in the household group (`AppShell.jsx` filters by the enabled set) |
| Direct URL (`/documents`) | A calm empty state: "This feature is off for your household" + an enable affordance (owners) or nothing (members). Not a 404, not an error |
| API | Plugin routes answer `404` with the standard error envelope (fail closed, no existence leak — same posture as foreign-household ids today) |
| Settings | A "Plugins" catalog screen listing available features with state and a one-tap enable/disable (owner-only) |
| Data | Nothing new is ever written: no rows, no bytes, no cron work, no AI spend |
| Ops cost | **Zero** marginal cost: no objects stored (R2 bills per stored object), no scheduled work, no model calls. The code rides the same deployed bundle — on Workers, deployed-but-inactive code costs nothing at runtime; bundle growth is a code-hygiene concern, not a customer cost |

"Never enabled" and "disabled" are deliberately the same state — there is no install step
for the customer. The plugin catalog in settings is the only place a household discovers
what exists.

### 3.3 Enablement granularity — recommendation: per household

**Recommendation: enablement is per household, with a separate per-deployment
availability gate for ops.** Two layers, two audiences:

| Layer | Audience | Mechanism | Example |
|---|---|---|---|
| **Household enablement** (the customer-facing choice) | household owner | Row in a core `household_plugins` table (household_id, plugin_id, status, timestamps) | A household turns the vault off |
| **Deployment availability** (the ops kill-switch) | owner/operator only | Config flag in `cloudflare.config.ts` wiring (env-shaped, not a customer setting) | Vault unavailability during a DokumenQ cutover incident |

Why per household (the owner's "customer can choose" wording points here; multi-tenant
analysis confirms it is cheap):

1. **RumaQ's tenancy unit is already the household.** Every vault artifact scopes to
   `household_id` (`documents.household_id`, audit rows, the ACTIVE-household recheck in
   `backend/src/auth.ts`). Enablement is just one more household-scoped fact — a table
   keyed exactly like everything else. No schema-per-tenant, no conditional migrations,
   nothing structurally new.
2. **Per-deployment-only enablement** (the Strapi model) cannot express two households of
   the same deployment wanting different things — and that is the actual product: one
   deployment, many households with different appetites. It survives here only as the ops
   layer above.
3. **Per-user enablement** is rejected: family features are household decisions. Two
   members of one household disagreeing about whether the vault exists is a worse product
   than any technical alternative. (Home Assistant reached the same shape: granularity at
   the config entry — the instance — not at the individual user.)
4. **Frontend implication:** the enabled set must arrive keyed to the ACTIVE household.
   It rides the authenticated bootstrap/me payload (additive field, §6) and re-fetches on
   household switch — the same lifecycle as every other active-household-scoped value.
5. **Authorization:** toggling enablement is owner-only (role = `owner`), matching the
   vault's existing owner-or-uploader delete rule and member-management authz.

### 3.4 Data ownership, export, retention when a plugin is disabled or removed

The vault's own design already encodes the right instincts (audit rows outlive the
documents they name; bytes are never orphaned silently). The plugin model generalizes it:

| Event | Rows | Bytes | Audit |
|---|---|---|---|
| **Disable** | Retained untouched ("dormant") | Retained (household may re-enable) | `plugin_disabled` event recorded |
| **Re-enable** | Everything returns exactly as left | — | `plugin_enabled` event recorded |
| **Disable + export** | Retained; household can download an archive (per-plugin export capability) | Retained | export event recorded |
| **Delete (purge)** | Plugin tables' household rows deleted (migration-free, app-level purge) | Purged through the port (adapter-agnostic) | Purge record retained — audit outlives data, same rule as `document_audit` |

Rules:

- **Disable never deletes.** A household that taps "turn off" must not lose wedding
  certificates because of a misclick. Deletion is a separate, owner-only, typed-
  confirmation flow, and the UI routes it through export-first.
- **Retention honesty:** while a plugin is disabled-but-not-purged, the household still
  stores bytes (R2 / later DokumenQ). Settings copy must say this in one sentence —
  "Your documents are kept while the feature is off; use Delete to remove them
  permanently." Zero-cost (§3.2) applies to households that never enabled or fully purged.
- **Household deletion** (leave/dissolve) cascades enablement rows and triggers each
  enabled plugin's purge path — one more reason purge must exist as a callable capability,
  not a manual runbook.

### 3.5 Rollout plan for the document vault (non-breaking, phased)

Each phase ships alone, is reversible, and is invisible or strictly additive to users.
No phase changes any URL, table shape, or contract field already shipped by #399.

| Phase | Ships | User-visible change |
|---|---|---|
| **A. Registry core** | Plugin manifest type + registry; `household_plugins` migration; existing households grandfathered as enabled; bootstrap payload gains an additive `enabledPlugins` field; gateway dispatches documents via the registry | None. Bit-for-bit same behavior |
| **B. Gating** | Frontend plugin context; nav filter; route guards with the disabled empty state; owner-only enable/disable | Only if a household *chooses* to disable: nav entry disappears; everything else unchanged |
| **C. Data lifecycle** | Plugins catalog in settings; export capability; owner-only purge flow with audit | New settings screen; no change to existing screens |
| **D. Adapter evolution** | Ports directory formalization; DokumenQ adapter behind `StorageAdapter` (#391 M3 Mode A); optional Mode B signed-URL follow-up | None (or faster downloads, if Mode B lands) |

Comms: Phases A–C need no announcement (they only add an off-switch). The first real
moment is the settings catalog itself — in-app, no email campaign required. Phase D is a
non-event for users by design; it is announced in the changelog only.

### 3.6 Success metrics

- **Adoption:** % of active households with the vault enabled; enable funnel from the
  settings catalog.
- **Choice health:** disable rate (target: low but nonzero — a never-touched off-switch is
  a signal the catalog is invisible); re-enable rate (target: high — disabling must not
  feel destructive); purge usage after disable (informs default-state decisions, §8).
- **Zero-cost of disabled, verified:** storage growth and AI spend attributable to
  disabled households = 0 (queryable from enablement rows vs object counts).
- **No regression from the refactor itself:** vault route p95 latency and error rate
  flat across Phases A–B (same middleware stack, dispatch via registry); support tickets
  mentioning "documents missing" ≈ 0.
- **Swap economics (Phase D):** adapter swap measured in PRs touching plugin files only
  (target: zero edits outside the adapter + config wiring) — the owner's original
  "easy and not breaking core" criterion, made checkable.

## 4. Perspective: Product Architect

### 4.1 The core/plugin boundary

**Core guarantees to every plugin** (things plugin code may take for granted, because the
registry installs them):

| Guarantee | Already exists as | Registry's addition |
|---|---|---|
| Auth context | `propsAuthMiddleware` — userId + ACTIVE household per request (COALESCE recheck, `backend/src/auth.ts`) | Auto-installed on every registered plugin app; a plugin cannot register a route without it |
| Household scoping | `household_id` predicates in SQL (the documents/households pattern) | Convention enforced in review + test: every plugin table carries `household_id NOT NULL REFERENCES households(id) ON DELETE CASCADE` |
| Error envelope | Per-app `onError` mapping typed errors (`apps/documents.ts`) | Registry wraps each plugin app with the standard envelope; plugins only throw typed errors |
| Rate limiting | `ipRateLimitMiddleware` + per-route limiters | Auto-installed; plugins add named per-route limits via manifest options |
| i18n | `en.json`/`id.json` namespaces (`documents.*` exists) | Plugin-owned namespace = plugin id; CI check: en+id parity for plugin keys |
| Scheduling | Single cron trigger (`triggers.scheduled` in `cloudflare.config.ts`) | Registry hands each plugin's declared task a wrapped slot: per-plugin try/catch, enablement check, failure audit |
| Contract codegen | `describeRoute` → `bun run api:codegen` → `frontend/openapi.json` → `api-schema.d.ts` | Plugin routes flow through the same pipeline unchanged (documents app already does) |
| Audit facility | `document_audit` vocabulary pattern | Core records lifecycle events (enabled/disabled/purged); in-plugin actions keep per-plugin audit tables |

**Forbidden to plugins** (enforced by convention + review + test-time checks, honestly not
by a runtime database ACL — see §4.4):

1. Importing core internals beyond the published core API surface (auth helpers, registry
   types, lib utilities). Core internals are anything not exported from the core entry.
2. Reading or writing **other plugins' tables** — each plugin owns `<plugin>_`-prefixed
   tables and nothing else.
3. Touching **core tables** (`users`, `households`, `user_settings`, `household_members`,
   `household_plugins`) directly; membership/household facts come from core helpers
   (`getMembership` is the existing example).
4. Touching **bindings directly** (`env.DOCUMENTS`, `env.RECEIPTS`, …) — all bytes and
   external services go through ports (§4.2).
5. Registering routes outside their declared prefix, or another plugin's i18n namespace.

The one-sentence rule for reviewers: *a plugin may import core's published API and its
own module, and nothing else.* A test-enforced import-boundary check (e.g. dependency
cruiser or a small convention test) makes this mechanical rather than tribal.

### 4.2 Port (adapter) contracts — where they live, how typed, how versioned

- **Location:** a `backend/src/ports/` directory. `StorageAdapter` moves there from
  `lib/storage.ts` unchanged in shape (the move is mechanical; import paths update in one
  file — the vault). The R2 adapter stays beside it (`ports/storage/r2.ts`), key-building
  helpers remain vault-owned (they are vault policy, not port policy — `buildDocumentKey`
  moves *with* the plugin).
- **Typing:** plain TypeScript interfaces with the existing zero-dep discipline. Ports are
  **implementation-agnostic by construction**: `StorageAdapter.put/get/delete` says nothing
  about R2, buckets, or URLs — which is precisely why the DokumenQ swap (Mode A in the
  [DokumenQ design](https://github.com/ahaqqu/DokumenQ/pull/1)) maps mechanically onto it.
- **Versioning without breaking either side — the additive-nullish rule applied to
  interfaces:**
  - Never change a method's signature; never remove one. New *capability* = a **new
    optional method or a new interface** (e.g. `StorageAdapterV2 extends StorageAdapter`
    with `resolveSignedUrl` — exactly DokumenQ's Mode B extension).
  - Adapters declare which port versions they implement; plugins declare which port
    versions they *require* (in the manifest). The registry validates the pairing at
    startup/test time; a mismatch fails the build, not a request.
  - Port changes ride the same PR review discipline as contract changes: additive first,
    breaking changes only when every consumer and adapter moves in the same PR.
- **Ports are few and earn their existence.** Candidate backlog, none created speculatively:
  `StorageAdapter` (exists), a notification port (push notifications decision doc exists),
  an AI/OCR port (receipt scan's Gemini dependency), a scheduling facade. A "port" with one
  plugin consumer *and* one implementation that will never change is a port in name only —
  keep it as a plain lib module until the second implementation is plausible.

### 4.3 Plugin manifest and lifecycle

- **Manifest:** a static typed object — not JSON, not scanned from disk. Each plugin is a
  directory under `backend/src/plugins/<id>/` exporting `manifest.ts` alongside its `app`
  (Hono sub-app), lib, and migration notes. Manifest fields: `id`, route prefix, owned
  tables, i18n namespace, nav contributions, settings panel reference, required ports +
  versions, declared cron tasks, capabilities (`providesExport`, `providesPurge`).
  Validation happens in a unit test + CI step (the Grafana scan-at-startup pattern, moved
  to build time because Workers have no startup scan worth failing at).
- **Install** is a developer/product act: the plugin directory exists and is registered in
  the registry's list. There is no customer-facing install, ever (§1.1 — first-party only).
- **Enable / disable** is the household's act: a row per (household, plugin). Disabled =
  gateway refuses the prefix (fail closed), nav filtered, cron tasks skipped, zero cost
  (§3.2). Enablement changes are audited core events.
- **Data on disable:** retained, dormant, exportable (§3.4).
- **Uninstall** is not a customer operation in v1 — it is a product decision to remove a
  plugin from the codebase entirely, which means: a final migration dropping the plugin's
  tables (forward-only, as always), a purge-everything sweep, and removal from the
  registry. Done in one deliberate PR; there is no half-state.

### 4.4 Failure isolation — what a single Cloudflare Worker honestly gives

A broken plugin must never break core or other plugins. On one Worker, be precise about
which isolation is real:

**Real, given by the platform:** every request executes in a V8 isolate; an exception in a
plugin route is caught by that app's `onError` and becomes a 500 for that request only;
the gateway already dispatches per-prefix (`households`, `documents` apps dispatch before
the `apiApp` fallthrough — `gateway.ts`), so a plugin failing cannot affect an
unrelated route's happy path. All code is fixed at deploy time — no runtime load, no eval
([Cloudflare](https://blog.cloudflare.com/workers-vitest-integration/)) — so "a broken
plugin" is always a bug we shipped, never an unpredictable artifact.

**Not real, and therefore enforced as build/test-time discipline instead:**

- The D1 database has no per-plugin ACL: any plugin code *can* technically touch any
  table. Mitigation: the import-boundary + table-ownership checks from §4.1 as CI tests,
  not runtime walls.
- One shared bundle: a plugin's unhandled promise rejection can crash the isolate for
  in-flight requests of everything. Mitigation: registry-installed wrappers — every cron
  task per-plugin try/catch + audit; every plugin app gets the standard envelope; and the
  same real-SQL test discipline the vault uses (migrations.test.ts pattern) covers plugin
  tables.
- Enablement lookup failing must **fail closed for the plugin, open for core**: if the
  `household_plugins` read errors, plugin routes answer 5xx (or 404) and core routes are
  untouched — enablement reads ride their own tiny statement, not a join with core auth.

**And the strongest boundary is not in the Worker at all:** the riskiest asset (document
bytes at rest) already sits behind a port whose next implementation (#391 DokumenQ) is a
separate process on the VPS — a real OS boundary for exactly the resource that deserves
one. Ports give RumaQ *graded* isolation: process boundary where it matters (bytes),
isolate + convention everywhere else.

### 4.5 UI surface registration

- **Manifest contributions:** nav entries (id, i18n key, icon, route path, nav group),
  settings panels, and route guards. Core composes them; plugins never edit `AppShell.jsx`.
  Concretely: the hard-coded `HOUSEHOLD_NAV` documents entry becomes `registry.filter(
  enabled)` — same visual result, declared source.
- **Frontend plugin context:** one provider fed by the bootstrap payload's additive
  `enabledPlugins` (keyed to the ACTIVE household, refetched on switch — §3.3).
- **Routes:** file-based routing stays exactly as it is (`frontend/src/routes/
  documents.jsx` etc.). Each plugin-owned route wraps in a plugin gate component:
  enabled → render; disabled → the calm empty state (§3.2) with owner-only enable
  affordance. URLs never move.
- **Settings panel:** the plugins catalog screen is core-owned; each plugin contributes
  only its descriptive copy + capabilities (export/purge buttons rendered from manifest
  capabilities). Plugin-specific settings (if a plugin ever needs them) live in
  `household_plugins.config_json` and render from a manifest-declared panel.

### 4.6 Configuration storage

| Kind of config | Lives in | Never in |
|---|---|---|
| Household enablement + small per-household plugin settings (non-secret JSON) | `household_plugins.status` / `config_json` | Code, env vars |
| Adapter/deployment wiring (bindings, endpoints) | `cloudflare.config.ts` bindings + Worker secrets (existing mechanics; names only, never values, in the repo) | D1, `.env`, plugin code |
| Feature/UX copy | i18n namespaces (en + id mandatory) | Hard-coded strings |

No plugin gets its own D1 database: shared `rumaq` DB with `<plugin>_` table prefixes
keeps migrations, backups, and cross-household admin queries in one place. Per-plugin
databases buy nothing at this scale and multiply deploy/backup surface (§5.2).

### 4.7 Migration plan: document vault → plugin

**What moves:** the `apps/documents.ts` + `lib/documents.ts` pair re-homes under
`backend/src/plugins/documents/` (app, lib, manifest); `StorageAdapter` moves to
`backend/src/ports/` (shape unchanged); the documents nav entry becomes a manifest
contribution; enablement rows are created for all existing households (grandfathered
enabled).

**What stays:** every URL (`/api/documents*`, `/documents`), both tables
(`documents`, `document_audit`) with their current shapes, the audit vocabulary, the
middleware stack, the `DOCUMENTS` R2 binding and private-bucket trust model (no public or
presigned URLs — `docs/ARCHITECTURE.md` §10), and `StorageAdapter` as adapter #1. The
`StorageAdapter` seam *is* the migration's anchor: the vault keeps compiling against it
while everything around it re-homes. No user-visible breakage — the phases in §3.5 are
the operational form of this plan.

**Compatibility with #391 DokumenQ** rides for free: DokumenQ's Mode A
(`DokumenQStorageAdapter` implementing `put/get/delete`; Worker still streams) is an
adapter swap inside the documents plugin; Mode B (`resolveSignedUrl`) is the port's
additive V2 extension, with the documented invariant change ("no *unauthenticated* byte
path; signed URLs are the only direct path") captured in the adapter comment at that
time. The plugin layer additionally guarantees the documents plugin is the *only* consumer
of the storage port, so a swap review reads one directory.

## 5. Alternatives considered and rejected

| Alternative | Why it was rejected |
|---|---|
| **1. Pure feature flags** (one boolean per feature in `user_settings`; no structural change) | Cheapest, and solves *nothing* the owner actually asked for: flags gate visibility but not lifecycle, data ownership, or implementation swap. The vault is already more than a flag (tables, bytes, audit). "Easy to change the document plugin to Google Drive" requires a seam flags cannot provide. Adopted *only* as the ops availability gate (§3.3), not as the architecture |
| **2. Microservice-per-plugin** (separate Worker per feature; Backstage-backend / Strapi-service style) | Breaks RumaQ's deploy discipline (`scripts/deploy.sh` is the single entrypoint — N plugins → N deploy targets, N secret surfaces, N preview branches), D1 cannot be shared across Workers cheaply (cross-plugin household queries become HTTP), latency and cost multiply. The strongest real boundary it buys (process isolation) is bought where it matters by ports instead (DokumenQ for bytes, §4.4). Revisit only if a plugin genuinely needs its own runtime (e.g. a heavy scraper) — the VPS pipeline repo already shows the pattern for that case |
| **3. Runtime-loaded modules** (fetch plugin code from R2/KV, `import()` at runtime) | Impossible on Workers (no `eval`/`new Function`; all code uploaded at deploy time) and a security anti-pattern even where possible (untrusted-code problem, cold-path complexity). Decisively closed by the platform |
| **4. Hooks-and-filters event bus** (WordPress-style `do_action`/`apply_filter` across core) | Maximum flexibility, minimum safety: unbounded reach into core and sibling plugins, ordering hazards, and every core change becomes a breaking-change audit across unknown interceptors. Directly contradicts "plugin talks to adapters rather than code". Ports + declared contributions give the same extension points with typed, auditable seams |
| **5. Per-plugin D1 database / full schema isolation** (Strapi's service-per-plugin instincts) | Multiplies migrations, backups, and deploy surface; cross-household admin surfaces (the audit feed, §3.4) become cross-database queries. Namespaced tables in one DB keep every existing discipline (single `db:migrate` path, EXPLAIN-proven indexes, real-SQL tests) intact |

## 6. Compatibility with existing disciplines

- **Additive-nullish contract rule.** The only contract change in Phases A–B is an
  additive, optional bootstrap field (`enabledPlugins`), following the same discipline as
  `member_id`'s nullability in #399. Plugin routes enter the same `describeRoute` →
  `bun run api:codegen` → `frontend/openapi.json` → `api-schema.d.ts` pipeline; no second
  contract mechanism is created. Contract edits stay additive; nothing existing is
  re-shaped.
- **Migrations.** Forward-only, single sequence: `household_plugins` is a normal numbered
  migration (0023-era); plugin tables keep the `<plugin>_` prefix; an uninstall, if ever,
  is itself a forward migration. The real-SQL migration test pattern (EXPLAIN-proven
  indexes, `migrations.test.ts`) extends to plugin tables at no extra mechanism.
- **Audit logging.** Core records lifecycle events (`plugin_enabled`, `plugin_disabled`,
  `plugin_purged`) in a core-owned audit table; in-plugin actions keep per-plugin audit
  tables exactly as `document_audit` does today (audit outlives the data it names). No
  plugin writes to another plugin's audit trail.
- **Deploy entrypoints.** `scripts/deploy.sh cloudflare` (and `vps` for the pipeline
  service) are untouched: plugins are directory structure inside the existing Worker and
  Pages bundles. Preview Workers for PR branches deploy plugins exactly like any other
  code; branch cleanup is unaffected.
- **Tests.** `scripts/test.sh unit` gains the registry-validation and import-boundary
  suites; the vault's existing tests migrate with its files and keep passing against
  real SQLite — the migration plan forbids rewriting test semantics in the move.
- **ahaqqu/vps discipline.** Nothing here changes host configuration. When #391's
  DokumenQ adapter lands (Phase D), its env additions go through the vps repo's `rumaq/`
  path per AGENTS.md — this design adds no second bootstrap path.
- **#391 DokumenQ.** Explicitly compatible: the port's shape already anticipates Mode A;
  Mode B is the additive V2 extension (§4.2, §4.7). The plugin boundary narrows DokumenQ's
  blast radius further: swapping adapters touches one plugin directory plus config wiring.

## 7. Proposed follow-up implementation tickets (proposed only — do not create yet)

Ordered; each is one shippable PR-sized unit, gated on owner sign-off of this design.

1. **Plugin registry core** — manifest type + validation test, registry list, `household_plugins` migration (with grandfathering), bootstrap `enabledPlugins` additive payload, gateway dispatch via registry (documents registered first), fail-closed enablement read. No frontend change.
2. **Frontend plugin gating** — plugin context provider (refetch on household switch), nav filter for `HOUSEHOLD_NAV`, route gate + disabled empty state, en+id lifecycle strings.
3. **Plugins settings catalog** — owner-only enable/disable with audit events, per-plugin copy, capabilities surface (§4.5).
4. **Document vault → plugin move** — re-home `apps/documents.ts` + `lib/documents.ts` under `plugins/documents/`, manifest contributions, `StorageAdapter` → `ports/` move, URL/table/audit contracts unchanged, existing tests migrate green.
5. **Data lifecycle** — per-plugin export capability (zip/CSV), owner-only purge flow with typed confirmation + audit record, household-dissolution purge hook.
6. **Cron handoff** — plugin-declared scheduled tasks with per-plugin enablement check, error isolation, and failure audit (the vault needs none today; this lands with the first plugin that does).
7. **Import-boundary enforcement** — CI test/dependency rule encoding §4.1's forbidden list (core internals, other plugins' tables, direct bindings).
8. **(After #391 M1/M2) DokumenQ storage adapter** — `DokumenQStorageAdapter` (Mode A) behind the unchanged `StorageAdapter` port, env/secret wiring via vps repo discipline, adapter-comment invariant update; Mode B (`resolveSignedUrl`) as the additive port V2 follow-up.

## 8. Open questions for the owner

1. **Default state for new households:** recommend vault **enabled by default** at the
   Phase B moment (grandfathering makes it continuous for existing households), then let
   the disable/re-enable metrics (§3.6) set per-plugin defaults later. Alternative:
   opt-in for everything from day one — more privacy-pure, worse discoverability.
2. **Google-Drive-style adapters:** the owner's example is honored architecturally (§2),
   but flagging a product tension: a "Google Drive adapter" moves family identity
   documents into a third party's cloud, against the private-vault positioning the trust
   model (§4.7) is built on. Recommendation: DokumenQ is the roadmap swap (#391); a
   consumer-cloud adapter stays hypothetical unless the owner wants a "bring your own
   drive" tier someday.
3. **UI naming:** "Plugins" is developer vocabulary. Candidate customer labels: id
   "Fitur" / "Modul", en "Features" / "Add-ons". Decision before Phase B copy.
4. **Purge grace window:** immediate destructive purge vs a 30-day soft window (DokumenQ's
   own open question #6 defaults 30 days). Aligning both products on one answer is worth
   a decision now.

## 9. References

- Charter: ahaqqu/RumaQ#400 (owner directive quoted in the status block above)
- Vault MVP: ahaqqu/RumaQ#388 / PR #399 — `backend/src/lib/storage.ts`,
  `backend/src/apps/documents.ts`, `backend/src/lib/documents.ts`,
  `backend/migrations/0022_document_vault.sql`
- Auth/household substrate: `backend/src/auth.ts` (`propsAuthMiddleware`,
  `ACTIVE_HOUSEHOLD_SQL`), `backend/src/apps/households.ts`, `backend/src/gateway.ts`
- Frontend surfaces: `frontend/src/components/AppShell.jsx`, `frontend/src/routes/`,
  `frontend/src/i18n/locales/{en,id}.json`, contract codegen
  (`scripts/api/generate-openapi-spec.ts` → `frontend/openapi.json` → `api-schema.d.ts`)
- Downstream storage swap: ahaqqu/DokumenQ#1 (`docs/DESIGN.md` — Mode A/Mode B adapter
  swap), charter ahaqqu/RumaQ#391
- Prior art sources: cited inline in §1 (Home Assistant contributors docs, Obsidian Help,
  VS Code API docs, WordPress Plugin Handbook + Wordfence, Backstage docs, Strapi docs,
  Grafana plugin tools docs, Cloudflare Workers blog)
