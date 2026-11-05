# Plugin architecture — core + adapters for optional features (document vault = first plugin)

> Status: **DRAFT for owner review** (PR #401; charter ahaqqu/RumaQ#400) — design only, no
> implementation in this ticket. Written 2026-11-04.
>
> **Revision 2 (2026-11-04, #421): amended after architecture review.** The direction is unchanged;
> seven things were wrong or missing and are fixed here: where the enablement gate can
> physically live (§4.3 — it cannot be the gateway), how a plugin receives its adapter (§4.1,
> §4.2 — today the vault builds its own R2 adapter from a binding), the purge lifecycle (§3.4 —
> it cannot be a request, and `ON DELETE CASCADE` cannot be its trigger), enablement resolution
> (§4.3 — absent row vs disabled row, which removes the grandfathering backfill), composition
> with the existing plan entitlements (§3.3, §6), the ops kill-switch latency (§3.3 — a config
> flag is a deploy), and the single-manifest assumption (§4.3 — the frontend cannot import a
> backend manifest). §3.6's latency claim is corrected accordingly. Facts are cited by file and
> line against `464b656`.
>
> The owner directive this document answers: _"the goal of rumaq is super app for managing
> home/house. not all customer want to use all of these features. so i think we should has
> concept plugin. for example storing document is a plugin. customer can choose not to use this
> feature. in future if i want to change this document plugin to something else (e.g. google
> drive) this should be easy and not breaking the core function. so we should has concept core
> and adapters. where plugin talks to adapters rather than code."_
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
  AppShell.jsx` hard-codes `NAV` / `HOUSEHOLD_NAV` groups) and in the gateway's
  hand-wired dispatch (`backend/src/gateway.ts` adds one `if` per domain app). Feature
  presence is a **code layout fact**, not a **product fact** a household controls.
- Commercial access is a separate fact that already exists: `user_plans` →
  `backend/src/lib/entitlements.ts` resolves a _user's_ plan to entitlements. It cannot
  express a household's choice (its unit is the user, and it is a paywall, not a preference).
  The two must compose rather than compete — §3.3, §6.
- The vault MVP already contains the two structural pieces this design generalizes:
  - an **adapter seam**: `StorageAdapter` (`backend/src/lib/storage.ts:27`, put/get/delete over
    private R2 via the `DOCUMENTS` binding in `cloudflare.config.ts:70`),
  - a **domain app**: `backend/src/apps/documents.ts` dispatched by prefix in `gateway.ts:70`,
    with the `documents`/`document_audit` tables from migration `0022`.

The question #400 asks: make _feature_ and _implementation_ both swappable — features
enable/disable per customer without breaking core, and implementations (R2 → DokumenQ →
"Google Drive") swap behind typed ports without breaking features.

## 1. Prior-art survey

Seven established plugin systems, surveyed for the four axes that matter here: boundary
style, enablement granularity, lifecycle, and permission model.

| System             | Boundary                                                                                                          | Enablement granularity                                                | Lifecycle                                                                                         | Permissions / trust                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Home Assistant** | In-process integrations; entities                                                                                 | Per **config entry** (≈ per instance of an integration, per home)     | `setup → setup_entry → unload_entry → remove`; reload/disable **without restart**                 | No sandbox — integrations are trusted core code, gated by review                                |
| **Obsidian**       | In-process, full API access                                                                                       | Per **vault** (per workspace of files)                                | Install → enable/disable per vault; "Restricted mode" kills all                                   | Manifest declares nothing enforceable; **no permission system** — enabled = full access         |
| **VS Code**        | **Out-of-process**: extensions run in a separate Node.js/Web Worker host, reachable only through the `vscode` API | Global default + **per workspace** override                           | Manifest + `contributes` (declared UI) + activation events (lazy load); disable = never activates | Declarative capability contributions; marketplace trust, no runtime ACL                         |
| **WordPress**      | In-process hooks (actions/filters)                                                                                | Per site install (enable/disable)                                     | Activate/deactivate; uninstall may orphan data                                                    | **None effective** — plugins are the majority of WP vulnerabilities; hooks can reach everything |
| **Backstage**      | Frontend: build-time composed packages; backend: separate deployables                                             | Per **app build** (install = compose) + per-user feature flags on top | Install at build time; feature flags toggle visibility at runtime                                 | npm/dependency trust; no per-plugin capability grants                                           |
| **Strapi**         | In-process npm packages                                                                                           | Per deployment via `config/plugins.js` (`enabled: false`)             | Install (npm) → enable/disable in config; data often survives uninstall unmanaged                 | Config-file trust; no user-facing permission model                                              |
| **Grafana**        | Frontend + backend plugin processes                                                                               | Per instance config (`plugins.<id>.disable`), per-dashboard exposure  | `plugin.json` manifest scanned at startup; signing gate; provisioning                             | **Signature verification** (trust gate before load); RBAC on top                                |

Sources: [HA config entries](https://contributors.home-assistant.io/core/integrations/config-entries),
[HA config-entry unloading quality scale](https://contributors.home-assistant.io/core/quality-scale/config-entry-unloading),
[HA config-entry state transitions](https://contributors.home-assistant.io/blog/2025/02/19/new-config-entry-states),
[Obsidian plugin security](https://obsidian.md/help/plugin-security),
[Obsidian community plugins](https://obsidian.md/help/community-plugins),
[VS Code extension host](https://code.visualstudio.com/api/advanced-topics/extension-host),
[VS Code activation events](https://code.visualstudio.com/api/references/activation-events),
[VS Code extension manifest](https://code.visualstudio.com/api/references/extension-manifest),
[WordPress plugin handbook — hooks](https://developer.wordpress.org/plugins/hooks/),
[Wordfence on WP request architecture & hooks](https://www.wordfence.com/blog/2024/07/wordpress-security-research-series-wordpress-request-architecture-and-hooks/),
[Backstage frontend system architecture](https://backstage.io/docs/frontend-system/architecture/index/),
[Backstage frontend plugins](https://backstage.io/docs/frontend-system/architecture/plugins/),
[Strapi plugins configuration](https://docs.strapi.io/cms/configurations/plugins),
[Grafana plugin.json reference](https://grafana.com/developers/plugin-tools/reference/plugin-json/),
[Grafana anatomy of a plugin](https://grafana.com/developers/plugin-tools/key-concepts/anatomy-of-a-plugin/).

VS Code's boundary is the one correction against the review: the extension host is a
**separate process** (or Web Worker in the browser), which is exactly why "prevent extensions
from impacting startup, slowing UI operations, or modifying the UI" is a property rather than
a promise. It is the strongest per-feature boundary in this table and still not available to
us (§4.4).

### 1.1 Synthesis — what RumaQ should adopt vs avoid

**Adopt:**

1. **Build-time composition, runtime enablement** (Backstage, Strapi, Grafana): plugin code
   ships in the monorepo bundle; _enablement is data, not code loading_. This is also the
   only option on Cloudflare Workers — the runtime disallows dynamic code evaluation
   (`eval`, `new Function`) and requires all code uploaded at deploy time ([Workers runtime
   limitations](https://developers.cloudflare.com/workers/runtime-apis/)).
2. **Config-entry-style per-tenant lifecycle** (Home Assistant): enablement is a **row with
   a state machine** (enabled/disabled + timestamps), teardown/re-enable without restart,
   and an explicit data-removal step separate from disable. HA's config entry is the
   closest prior art to what a RumaQ household needs.
3. **Declared UI contributions** (VS Code `contributes`, Grafana `plugin.json`): a plugin
   _declares_ its nav entries, routes, and settings panels; core renders them only when
   enabled. Nothing reaches into `AppShell.jsx` imperatively.
4. **Startup manifest validation** (Grafana): manifests are validated by a test/CI step, so
   a malformed plugin fails the build, never the runtime.
5. **Ports, not hooks** (the healthy half of every system above): plugins depend on narrow
   typed interfaces owned by core, never on core internals.

**Avoid:**

1. **WordPress's hooks-and-filters bus.** Unbounded reach into core and sibling plugins is
   exactly why WP plugins dominate its vulnerability reports and why WP upgrades are
   feared ([Wordfence](https://www.wordfence.com/blog/2024/07/wordpress-security-research-series-wordpress-request-architecture-and-hooks/)).
   RumaQ wants _swappable seams_ with a single consumer each, not an interception mesh.
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
                                       │ "Google Drive"-style (hypo)  │
                                       └──────────────────────────────┘
```

- **Core** — everything a household cannot opt out of: auth, households/members, the
  plugin registry, contract codegen, deploy plumbing. Core knows _which plugins exist_
  (it must, to dispatch) but has **zero feature logic** for any of them.
- **Plugin** — an optional feature: routes, tables, i18n keys, nav entries, settings.
  Talks **only to ports and its own code**. Never imports another plugin, never touches
  core tables directly.
- **Port (adapter interface)** — a typed contract core owns and plugins consume.
  `StorageAdapter` is port #1; it already exists in exactly this role.
- **Adapter** — an implementation of a port. Swapping R2 → DokumenQ (#391) → a
  Google-Drive-style service changes **one adapter file**, not the plugin, not core —
  the owner's requirement verbatim.
- **Resolution** — enablement is not stored as a boolean per household; it is _resolved_
  from an optional row against a manifest default (§4.3). Everything that gates a request
  goes through that one resolver.

The critical separation the owner asked for: _"customer can choose not to use this
feature"_ is the **plugin** axis (enablement); _"change this document plugin to something
else (e.g. google drive)"_ is the **adapter** axis (implementation swap). They are
orthogonal. A Google Drive adapter would swap what _stores the bytes_; it does not disable
the vault feature.

## 3. Perspective: Product Manager

### 3.1 User value

- **A super app that respects choice.** Households come for groceries and inventory; the
  document vault is intimate. Making it a plugin means a household that never asked for
  private-document storage never sees it, never wonders what it does with KTP scans, and
  never carries the cognitive load of an unused surface in nav or settings.
- **Trust as a feature.** "Disable" is a visible, reversible commitment that _your
  household's data is not being kept_. For Indonesian family documents (identity papers),
  the ability to turn the vault off — and to export-then-purge — is a differentiator, not
  a concession.
- **Owner velocity.** The same structure lets the owner replace implementations (self-host
  DokumenQ per #391) or retire/replace whole features without destabilizing what
  households rely on daily.

### 3.2 What "customer chose not to use this plugin" means concretely

For a household with the documents plugin **disabled**, every one of these is true:

| Surface                   | Disabled experience                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nav                       | No Documents entry in the household group (`AppShell.jsx` renders the filtered catalog at three sites: title lookup, sidebar, mobile drawer)                                                                                                                                  |
| Direct URL (`/documents`) | A calm empty state: "This feature is off for your household" + an enable affordance (owners) or nothing (members). Not a 404, not an error                                                                                                                                    |
| API                       | Plugin routes answer `404` with the standard error envelope — fail closed and consistent with the foreign-household posture. Not a secrecy claim: the settings catalog advertises every plugin anyway                                                                         |
| Settings                  | A "Plugins" catalog screen listing available features with state and a one-tap enable/disable (owner-only)                                                                                                                                                                    |
| Data                      | Nothing new is ever written: no rows, no bytes, no cron work, no AI spend                                                                                                                                                                                                     |
| Ops cost                  | **Zero** marginal cost for a household that never enabled or fully purged: no objects stored, no scheduled work, no model calls. R2 bills GB-month and operations, not a per-object fee; a disabled-but-not-purged household still pays for the bytes it chose to keep (§3.4) |

The code rides the same deployed bundle — on Workers, deployed-but-inactive code costs
nothing at runtime; bundle growth is a code-hygiene concern (and a script-size ceiling), not
a customer cost.

"Never enabled" and "turned off" are the same **experience**: routes deny, nav hides, there
is no install step. They differ only in the data — no row versus a `disabled` row — and that
difference is exactly what makes the metrics in §3.6 readable. The plugin catalog in
settings is the only place a household discovers what exists.

### 3.3 Enablement granularity — recommendation: per household

**Recommendation: enablement is per household, with a separate per-deployment availability
gate for ops and a separate plan entitlement for commerce.** Three layers, three audiences,
one resolver:

| Layer                                                 | Audience            | Mechanism                                                                                                 | Example                                     |
| ----------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Household enablement** (the customer-facing choice) | household owner     | Row in a core `household_plugins` table; an absent row resolves to the manifest's `defaultEnabled` (§4.3) | A household turns the vault off             |
| **Deployment availability** (the ops kill-switch)     | owner/operator only | `deployment_flags` row read once per isolate (≤30 s cache); `cloudflare.config.ts` carries defaults only  | Pausing the vault during a DokumenQ cutover |
| **Plan entitlement** (the commercial gate)            | billing / product   | `user_plans` → `backend/src/lib/entitlements.ts` (`requireEntitlement`, currently all-free and per-user)  | A paid tier that includes the vault         |

**Effective access = deployment available ∧ plan entitled ∧ household enabled.** Denials
stay distinguishable so the UI can say the right sentence: `404` for household-disabled or
deployment-off (both "not here", neither actionable), `403` for unentitled (the only denial
with an upgrade path). The failure postures differ on purpose and must not be unified:
household enablement fails **closed** (a privacy promise), the deployment flag fails
**open** (a flags outage must not take the vault down), plan resolution fails to `free`
(the existing behaviour in `resolvePlan`).

The ops layer moved out of the config file in revision 2: a flag in `cloudflare.config.ts`
is a PR plus a deploy, which is the wrong latency for the incident it exists to handle
("vault unavailable during a cutover"). The flag is data; the config file only wires the
defaults.

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
   It rides the authenticated `/api/me` payload (additive field, §6) and refetches on
   household switch — the same lifecycle as every other active-household-scoped value.
5. **Authorization:** toggling enablement is owner-only (`requireOwner`,
   `backend/src/lib/households.ts:116`), matching the vault's existing owner-or-uploader
   delete rule and member-management authz.

### 3.4 Data ownership, export, retention when a plugin is disabled or removed

The vault's own design already encodes the right instincts (audit rows outlive the
documents they name; bytes are never orphaned silently). The plugin model generalizes it —
with one correction: purge cannot be a request handler (§4.3, §6).

| Event                     | Rows                                                                       | Bytes                                      | Audit                                                            |
| ------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| **Disable**               | Retained untouched ("dormant")                                             | Retained (household may re-enable)         | `plugin_disabled` event recorded                                 |
| **Re-enable**             | Everything returns exactly as left                                         | —                                          | `plugin_enabled` event recorded                                  |
| **Disable + export**      | Retained; household can download an archive (per-plugin export capability) | Retained                                   | export event recorded                                            |
| **Delete (purge)**        | Plugin tables' household rows deleted **after** the bytes are gone         | Purged through the port (adapter-agnostic) | `plugin_purged` written once, at completion — never at the start |
| **Household dissolution** | Purge runs to completion **before** the household row is deleted           | Same path                                  | Same record, retained                                            |

Rules:

- **Disable never deletes.** A household that taps "turn off" must not lose wedding
  certificates because of a misclick. Deletion is a separate, owner-only, typed-
  confirmation flow, and the UI routes it through export-first.
- **Purge is a job, not a request.** A `purge_state` (`pending → running → done` plus a
  cursor) lives on the enablement row; the existing daily cron drives chunks of documents;
  each document is processed bytes-then-row (the order `deleteDocument` already uses) and is
  idempotent, so a crash or a timeout resumes from the cursor. Why: the port has no `list`
  by design — "the D1 index owns listing" (`backend/src/lib/storage.ts:23`) — so keys come
  from `buildDocumentKey` (`storage.ts:40`) **before** their rows go; and a 200-document
  vault is 200 R2 deletes plus D1 writes, past the per-invocation subrequest cap (50 free /
  1000 paid) if attempted in one request. A request-scoped purge would half-complete and
  leave bytes with no index entry.
- **Household dissolution is ordered, not cascaded.** Mark the household, run the purge
  jobs, then delete the household row. `documents.household_id` is
  `ON DELETE CASCADE` (`0022_document_vault.sql:12`) — correct for referential integrity,
  wrong as a purge trigger, because the cascade erases the only record of `storage_key` and
  with it the ability to find the bytes.
- **Retention honesty:** while a plugin is disabled-but-not-purged, the household still
  stores bytes (R2 / later DokumenQ). Settings copy must say this in one sentence —
  "Your documents are kept while the feature is off; use Delete to remove them
  permanently." Zero-cost (§3.2) applies to households that never enabled or fully purged.
- **Audit at dissolution.** `document_audit.household_id` is also `ON DELETE CASCADE`
  (`0022:54`), so today's trail cannot survive a household deletion. If "purge record
  retained" is the promise, the **core** lifecycle table must reference households by a
  plain handle with no FK — an audit row is not a child of the household, it is the receipt
  for one. Retention horizon is an owner decision (§8.5).
- **Legal.** Purge completion is also the evidence UU PDP 27/2022 expects for an erasure
  request; the settings sentence must not promise more than the table can prove.
- **Household deletion** (leave/dissolve) cascades enablement rows only _after_ each enabled
  plugin's purge has completed — the purge is a precondition of the cascade, not its
  consequence. One more reason purge must exist as a callable capability, not a manual
  runbook.

### 3.5 Rollout plan for the document vault (non-breaking, phased)

Each phase ships alone, is reversible, and is invisible or strictly additive to users.
No phase changes any URL, table shape, or contract field already shipped by #399.

| Phase                    | Ships                                                                                                                                                                                                                                                                                                                                                                                                | User-visible change                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **A. Registry core**     | Plugin manifest type + validation; plugin **factory** contract; port injection; `household_plugins` migration and resolver (`defaultEnabled`, so no grandfathering backfill); bootstrap `enabledPlugins` additive field; gateway dispatch via registry; enablement middleware; `deployment_flags`; import-boundary rules (allow-list empty until the vault move, ticket 4); `ARCHITECTURE.md` update | None. Bit-for-bit same behavior                                                           |
| **B. Gating**            | Frontend plugin context (refetch on household switch, absent field = all enabled); nav filter at all three render sites; route gates with the disabled empty state; owner-only enable/disable                                                                                                                                                                                                        | Only if a household _chooses_ to disable: nav entry disappears; everything else unchanged |
| **C. Data lifecycle**    | Plugins catalog in settings; purge job (state machine, chunked, audited) with household-dissolution ordering; core lifecycle audit table                                                                                                                                                                                                                                                             | New settings screen; no change to existing screens                                        |
| **D. Adapter evolution** | Ports directory formalization; DokumenQ adapter behind `StorageAdapter` (#391 M3 Mode A); optional Mode B signed-URL follow-up                                                                                                                                                                                                                                                                       | None (or faster downloads, if Mode B lands)                                               |

Export (archive download) is deliberately not in Phase C's critical path — it is its own
ticket after purge, because purge must not wait on zip/CSV plumbing (§7).

Comms: Phases A–C need no announcement (they only add an off-switch). The first real
moment is the settings catalog itself — in-app, no email campaign required. Phase D is a
non-event for users by design; it is announced in the changelog only.

### 3.6 Success metrics

- **Adoption:** % of active households with the vault enabled; enable funnel from the
  settings catalog.
- **Choice health:** disable rate (target: low but nonzero — a never-touched off-switch is
  a signal the catalog is invisible); re-enable rate (target: high — disabling must not
  feel destructive); purge usage after disable (informs default-state decisions, §8).
- **Zero-cost of disabled, verified:** storage growth attributable to disabled households =
  0 **beyond the bytes retained at disable** (queryable as object count per plugin key
  namespace, against enablement rows). The "growth" qualifier matters: §3.4 deliberately
  keeps bytes until purge.
- **No regression from the refactor itself:** the refactor is not free — the gate adds one
  indexed D1 read per plugin request, and the deployment flag adds one read per isolate.
  "No regression" therefore means: vault route p95 and error rate stay inside that added
  budget, measured in Phase B, not asserted from "same middleware stack" (the stack is not
  the same). Support tickets mentioning "documents missing" ≈ 0.
- **Swap economics (Phase D):** adapter swap measured in PRs touching plugin files only
  (target: zero edits outside the adapter + config wiring) — the owner's original
  "easy and not breaking core" criterion, made checkable.

## 4. Perspective: Product Architect

### 4.1 The core/plugin boundary

**Core guarantees to every plugin** (things plugin code may take for granted, because the
registry installs them):

| Guarantee         | Already exists as                                                                                                            | Registry's addition                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth context      | `propsAuthMiddleware` — userId + ACTIVE household per request (`backend/src/auth.ts:143`, query at `:166`)                   | Installed by the wrapper on `'*'` **before** the plugin registers a route (factory contract, §4.3); a plugin cannot register a route without it                                                              |
| Plugin enablement | —                                                                                                                            | The same wrapper installs the gate immediately after auth; it is the only reader of `household_plugins`                                                                                                      |
| Ports (injected)  | `StorageAdapter` (`backend/src/lib/storage.ts:27`)                                                                           | Registry builds adapters from wiring and passes them into `createApp({ ports })`; plugins read no binding except `env.DB`                                                                                    |
| Household scoping | `household_id` predicates in SQL (the documents/households pattern)                                                          | Convention enforced in review + test: every plugin table carries `household_id NOT NULL REFERENCES households(id) ON DELETE CASCADE` — **except audit tables**, which must outlive the rows they name (§3.4) |
| Error envelope    | Per-app `onError` mapping typed errors (`apps/documents.ts:109`)                                                             | Registry wraps each plugin app with the standard envelope; plugins only throw typed errors                                                                                                                   |
| Rate limiting     | `ipRateLimitMiddleware` (`backend/src/lib/rate-limit.ts:62`) + per-route limiters                                            | Auto-installed; plugins add named per-route limits via manifest options                                                                                                                                      |
| i18n              | `en.json`/`id.json` namespaces (`documents.*` exists)                                                                        | Plugin-owned namespace = plugin id; new CI check: en+id parity for plugin keys                                                                                                                               |
| Scheduling        | Single cron trigger (`triggers.scheduled` in `cloudflare.config.ts:61`)                                                      | Registry hands each plugin's declared task a wrapped slot: per-plugin try/catch, enablement check, failure audit (fan-out semantics deferred, §4.3)                                                          |
| Contract codegen  | `describeRoute` → `bun run api:codegen` (`vite.config.ts:68`) → `frontend/openapi.json` → `frontend/src/lib/api-schema.d.ts` | Plugin routes flow through the same pipeline unchanged (documents app already does)                                                                                                                          |
| Audit facility    | `document_audit` vocabulary pattern                                                                                          | Core records lifecycle events (enabled/disabled/purged); in-plugin actions keep per-plugin audit tables                                                                                                      |

**Forbidden to plugins** (enforced by convention + review + test-time checks, honestly not
by a runtime database ACL — see §4.4):

1. Importing core internals beyond the published core API surface (auth helpers, registry
   types, lib utilities). Core internals are anything not exported from the core entry.
2. Reading or writing **other plugins' tables**. Ownership is **declared** in the manifest
   (`ownedTables`) and tested for disjointness, deliberately not inferred from a prefix:
   the vault's tables are `documents` and `document_audit`, which do not share a
   `documents_` prefix, and that is fine once the list is explicit. The `<plugin>_` prefix
   is a guideline for new tables, not the enforcement.
3. Touching **core tables** (`users`, `households`, `user_settings`, `household_members`,
   `household_plugins`) directly; membership/household facts come from core helpers
   (`getMembership`, `household_members`; `requireOwner` for owner checks). A plugin reads
   its own enablement state through a core helper, never through SQL.
4. Touching **bindings** other than `env.DB` (`env.DOCUMENTS`, `env.RECEIPTS`, AI keys) —
   bytes and external services go through ports (§4.2). The vault breaks this today: three
   inline `createR2StorageAdapter(c.env.DOCUMENTS)` calls (`apps/documents.ts:354,453,498`).
   Removing them is the point of the factory conversion, not churn.
5. Registering routes outside their declared prefix, or another plugin's i18n namespace.

The one-sentence rule for reviewers: _a plugin may import core's published API, its own
module, and `env.DB` — nothing else._ A test-enforced import-boundary check (dependency
cruiser or a small convention test) makes this mechanical rather than tribal.

### 4.2 Port (adapter) contracts — where they live, how typed, how versioned

- **Location:** a `backend/src/ports/` directory. `StorageAdapter` moves there from
  `lib/storage.ts` unchanged in shape. The R2 adapter stays beside it (`ports/storage/r2.ts`),
  key-building helpers remain vault-owned (they are vault policy, not port policy —
  `buildDocumentKey` moves _with_ the plugin). Import paths update in
  `apps/documents.ts`, its test (`__tests__/documents-sql.test.ts:38`), and two comments
  (`types.ts:22`, `cloudflare.config.ts:67`) — mechanical, but it touches the suite, so
  budget it as a real PR rather than a rename.
- **Typing:** plain TypeScript interfaces with the existing zero-dep discipline. Ports are
  **implementation-agnostic by construction**: `StorageAdapter.put/get/delete` says nothing
  about R2, buckets, or URLs — which is precisely why the DokumenQ swap (Mode A in the
  [DokumenQ design](https://github.com/ahaqqu/DokumenQ/pull/1)) maps mechanically onto it.
- **Versioning without breaking either side — the additive-nullish rule applied to
  interfaces, one mechanism, not three:**
  - Never change a method's signature; never remove one. New _capability_ = a **new
    optional method or a new interface** (e.g. `StorageAdapterV2 extends StorageAdapter`
    with `resolveSignedUrl` — exactly DokumenQ's Mode B extension).
  - The compile-time check lives at the single wiring site: `const storage = { ... }
    satisfies StorageAdapterV2`. The runtime check is capability detection —
    `'resolveSignedUrl' in adapter` — for the one case where config picks the adapter.
    Manifest `requiredPorts` declares the id and capability a plugin needs; the registry
    fails the build if the wired adapter cannot satisfy it.
  - Manifest port **version strings** are dropped in revision 2. TS structural typing plus
    `satisfies` already fails the build on a missing method; a second, stringly-typed
    version ledger would be a third source of truth that can drift. Reintroduce versions
    only if two adapters must genuinely coexist behind config and offer different
    capabilities to different plugins.
  - Port changes ride the same PR review discipline as contract changes: additive first,
    breaking changes only when every consumer and adapter moves in the same PR.
- **Purge needs no `list`.** Keys come from the plugin's own index, which is why the port
  stays three methods. A bulk `deleteMany(keys)` is the one additive method worth
  considering for purge throughput (R2 deletes in batches of up to 1000) — optional, and
  only if Phase C measures a problem.
- **Ports are few and earn their existence.** Candidate backlog, none created speculatively:
  `StorageAdapter` (exists), a notification port (push notifications decision doc exists),
  an AI/OCR port (receipt scan's Gemini dependency), a scheduling facade. A "port" with one
  plugin consumer _and_ one implementation that will never change is a port in name only —
  keep it as a plain lib module until the second implementation is plausible.

### 4.3 Plugin manifest, construction, and lifecycle

- **Two manifests, because there are two bundles.** `frontend/` and `backend/` are separate
  packages with no shared module graph (verified: no cross-imports), so a nav entry's icon
  and a settings panel cannot live in a backend object.
  - **Server** — `backend/src/plugins/<id>/manifest.ts`: `id`, `routePrefix`,
    `ownedTables`, `requiredPorts`, `defaultEnabled`, `cronTasks`.
  - **Frontend** — `frontend/src/plugins/<id>/catalog.tsx`: nav entries (icon, i18n key,
    route path, nav group), settings panel component, capability copy.
  - **Parity test** both ways: every server id has a catalog entry and vice versa; every
    catalog route lives under the server's prefix. `/api/me` carries **ids only**.
  - Both are static typed objects — not JSON, not scanned from disk. Validation happens in a
    unit test + CI step (the Grafana scan-at-startup pattern, moved to build time because
    Workers have no startup scan worth failing at). Validation covers: every directory
    under `plugins/` is registered exactly once; ids and prefixes unique and boundary-safe;
    `ownedTables` disjoint across plugins; port capabilities satisfied by the wired
    adapter; i18n namespace present in both locales.
- **Construction is a factory, not a singleton.** Each plugin exports
  `createDocumentsPlugin(deps: PluginDeps): PluginApp` where `PluginDeps = { ports }`; the
  registry composes `logger → createCors → ipRateLimitMiddleware → propsAuthMiddleware →
  pluginGate(id) → plugin routes → onError`, then the plugin registers its routes onto the
  app it was handed. Why this is not optional: `documentsApp` is today a module-level
  `new Hono()` with routes registered at import time (`apps/documents.ts:103`), so middleware
  installed by a registry cannot be guaranteed to run ahead of them — and the file itself
  documents the `use()` subpath landmine (#292) that forced it to enumerate
  `propsAuthMiddleware` per path (`:121-123`). A factory makes "cannot register a route
  without auth" a structural property and gives the registry the one place where an adapter
  can be injected.
- **Prefix matching stays boundary-aware.** The gateway's existing test is
  `path === p || path.startsWith(p + '/')` (`gateway.ts:70`); a registry loop must keep it,
  or `/api/documents-x` starts dispatching into the vault.
- **Install** is a developer/product act: the plugin directory exists and is registered in
  the registry's list. There is no customer-facing install, ever (§1.1 — first-party only).
- **Enablement is resolved, never a bare boolean:**

  | `household_plugins` row | `manifest.defaultEnabled` | Effective         | Decided by     |
  | ----------------------- | ------------------------- | ----------------- | -------------- |
  | absent                  | `true`                    | **enabled**       | plugin default |
  | absent                  | `false`                   | disabled          | plugin default |
  | `status = 'enabled'`    | any                       | **enabled**       | household      |
  | `status = 'disabled'`   | any                       | disabled          | household      |
  | read error              | —                         | disabled (logged) | fail closed    |

  This removes the grandfathering backfill that revision 1 needed: `documents` ships with
  `defaultEnabled: true`, so every existing household resolves enabled with **zero rows**
  and no data migration. Turning a default off later changes only households that never
  expressed a choice; explicit rows survive. It also settles §8.1 without touching household
  creation.

- **Enable / disable** is the household's act: a row per (household, plugin), owner-only,
  audited (`plugin_enabled` / `plugin_disabled`). Disabled = **the plugin's own gate
  middleware** answers `404` for every route in its prefix, nav filtered, cron tasks
  skipped, zero cost (§3.2). It cannot be the gateway: dispatch is path-only
  (`gateway.ts:70`) and the household is unknown until `propsAuthMiddleware` has run
  (`auth.ts:143,166`), so a gateway-level check would have to re-implement auth or guess.
- **Gate cost:** one indexed D1 read per plugin request, deliberately not joined with the
  auth statement (§4.4 explains why the failure semantics must stay separate). No
  cross-request cache in v1 — invalidation is a correctness risk worth more than one local
  read; revisit only if Phase B measurement says otherwise.
- **Data on disable:** retained, dormant, exportable (§3.4).
- **Scheduling (deferred, named now):** `cronTasks` entries carry a `scope` (`global` vs
  `household`) so the field does not need a breaking change when the first task lands. A
  household-scoped task iterates the enabled set from one query; a global task ignores
  enablement. No plugin in v1 needs either — the vault has none.
- **Uninstall** is not a customer operation in v1 — it is a product decision to remove a
  plugin from the codebase entirely, which means: a final migration dropping the plugin's
  tables (forward-only, as always), clearing its `household_plugins` rows, a
  purge-everything sweep, and removal from the registry. Done in one deliberate PR; there
  is no half-state.

### 4.4 Failure isolation — what a single Cloudflare Worker honestly gives

A broken plugin must never break core or other plugins. On one Worker, be precise about
which isolation is real:

**Real, given by the platform:** every request executes in a V8 isolate; an exception in a
plugin route is caught by that app's `onError` and becomes a 500 for that request only;
the gateway already dispatches per-prefix (`households`, `documents` apps dispatch before
the `apiApp` fallthrough — `gateway.ts:65-71`), so a plugin failing cannot affect an
unrelated route's happy path. All code is fixed at deploy time — no runtime load, no
`eval` — so "a broken plugin" is always a bug we shipped, never an unpredictable artifact.

**Not real, and therefore enforced as build/test-time discipline instead:**

- The D1 database has no per-plugin ACL: any plugin code _can_ technically touch any
  table. Mitigation: the import-boundary + table-ownership checks from §4.1 as CI tests,
  not runtime walls.
- One shared bundle: a rejection that escapes a request handler is not something `onError`
  reliably contains — the isolate can be terminated with in-flight requests of every
  plugin inside it. Mitigation: registry-installed wrappers — every cron task per-plugin
  try/catch + audit, every plugin app gets the standard envelope, and `waitUntil` promises
  that never reject; plus the real-SQL test discipline the vault uses
  (`migrations.test.ts` pattern) for plugin tables.
- Enablement lookup failing must **fail closed for the plugin, open for core**: if the
  `household_plugins` read errors, plugin routes answer 5xx (or 404) and core routes are
  untouched — enablement reads ride their own tiny statement, not a join with core auth.
  That is a deliberate latency purchase (§3.6), not an oversight.

**And the strongest boundary is not in the Worker at all:** the riskiest asset (document
bytes at rest) already sits behind a port whose next implementation (#391 DokumenQ) is a
separate process on the VPS — a real OS boundary for exactly the resource that deserves
one. Ports give RumaQ _graded_ isolation: process boundary where it matters (bytes),
isolate + convention everywhere else.

### 4.5 UI surface registration

- **Contributions:** nav entries (id, i18n key, icon, route path, nav group), settings
  panels, and route guards are declared in the **frontend catalog** (§4.3) — the backend
  manifest cannot carry React. Core composes them; plugins never edit `AppShell.jsx`.
  Concretely: the hard-coded `HOUSEHOLD_NAV` documents entry becomes
  `catalog.filter(enabled)` — same visual result, declared source.
- **The filter has three call sites, not one.** `AppShell.jsx:197` builds `navItems` for the
  page title lookup, `:287` renders the sidebar, `:423` renders the mobile drawer. Filter
  once in the provider and feed all three, or mobile keeps showing a disabled surface.
- **Frontend plugin context:** one provider fed by `/api/me`'s additive `enabledPlugins`
  (keyed to the ACTIVE household, refetched on switch — §3.3). **A response without the
  field means "all catalog plugins enabled"** — a stale PWA bundle, a rolled-back API
  deploy, or a parse failure must never hide a surface; the backend still enforces the
  gate, so failing open on the client is safe and failing closed is a visible outage.
- **Routes:** file-based routing stays exactly as it is (`frontend/src/routes/
  documents.jsx` etc.). Each plugin-owned route wraps in a plugin gate component:
  enabled → render; disabled → the calm empty state (§3.2) with owner-only enable
  affordance. URLs never move. (TanStack's route tree is build-time codegen, so
  manifest-contributed routes are explicitly out of scope — the gate is the contribution.)
- **Settings panel:** the plugins catalog screen is core-owned; each plugin contributes
  only its descriptive copy + capabilities (export/purge buttons rendered from catalog
  capabilities). Plugin-specific settings (if a plugin ever needs them) live in
  `household_plugins.config_json` and render from a catalog-declared panel component.

### 4.6 Configuration storage

| Kind of config                                                               | Lives in                                                                                                     | Never in                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Household enablement + small per-household plugin settings (non-secret JSON) | `household_plugins.status` / `config_json`                                                                   | Code, env vars          |
| Deployment availability (ops kill-switch)                                    | `deployment_flags` rows, read once per isolate with a ≤30 s cache; defaults in `cloudflare.config.ts`        | Code paths, plugin code |
| Adapter/deployment wiring (bindings, endpoints)                              | `cloudflare.config.ts` bindings + Worker secrets (existing mechanics; names only, never values, in the repo) | D1, `.env`, plugin code |
| Feature/UX copy                                                              | i18n namespaces (en + id mandatory)                                                                          | Hard-coded strings      |

No plugin gets its own D1 database: shared `rumaq` DB with `<plugin>_` table prefixes
keeps migrations, backups, and cross-household admin queries in one place. Per-plugin
databases buy nothing at this scale and multiply deploy/backup surface (§5.2).

### 4.7 Migration plan: document vault → plugin

**What moves:** the `apps/documents.ts` + `lib/documents.ts` pair re-homes under
`backend/src/plugins/documents/` as a **factory** (`createDocumentsPlugin`) with a server
manifest; `StorageAdapter` moves to `backend/src/ports/` (shape unchanged); the documents
nav entry becomes a frontend catalog contribution. The three inline
`createR2StorageAdapter(c.env.DOCUMENTS)` call sites become an injected `ports.storage`.
Existing tests migrate with their files and keep passing against real SQLite — the migration
plan forbids rewriting test semantics in the move.

**What stays:** every URL (`/api/documents*`, `/documents`), both tables (`documents`,
`document_audit`) with their current shapes — including the deliberate absence of an FK on
`document_audit.document_id` — the audit vocabulary, the middleware stack, the `DOCUMENTS`
R2 binding and private-bucket trust model (no public or presigned URLs —
`docs/ARCHITECTURE.md` §10), and `StorageAdapter` as adapter #1. The `StorageAdapter` seam
_is_ the migration's anchor: the vault keeps compiling against it while everything around it
re-homes. No user-visible breakage — the phases in §3.5 are the operational form of this
plan.

**Compatibility with #391 DokumenQ** rides for free: DokumenQ's Mode A
(`DokumenQStorageAdapter` implementing `put/get/delete`; Worker still streams) is an
adapter swap inside the documents plugin; Mode B (`resolveSignedUrl`) is the port's
additive V2 extension, with the documented invariant change ("no _unauthenticated_ byte
path; signed URLs are the only direct path") captured in the adapter comment at that
time. The plugin layer additionally guarantees the documents plugin is the _only_ consumer
of the storage port, so a swap review reads one directory.

## 5. Alternatives considered and rejected

| Alternative                                                                                            | Why it was rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Pure feature flags** (one boolean per feature in `user_settings`; no structural change)           | Cheapest, and solves _nothing_ the owner actually asked for: flags gate visibility but not lifecycle, data ownership, or implementation swap. The vault is already more than a flag (tables, bytes, audit). "Easy to change the document plugin to Google Drive" requires a seam flags cannot provide. Note what RumaQ already has: `user_plans` → `lib/entitlements.ts` is a _per-user commercial_ gate for a different question, and overloading it with household choice would conflate a paywall with a preference. Adopted _only_ as the ops availability gate (§3.3), not as the architecture |
| **2. Microservice-per-plugin** (separate Worker per feature; Backstage-backend / Strapi-service style) | Breaks RumaQ's deploy discipline (`scripts/deploy.sh` is the single entrypoint — N plugins → N deploy targets, N secret surfaces, N preview branches), D1 cannot be shared across Workers cheaply (cross-plugin household queries become HTTP), latency and cost multiply. The strongest real boundary it buys (process isolation) is bought where it matters by ports instead (DokumenQ for bytes, §4.4). Revisit only if a plugin genuinely needs its own runtime (e.g. a heavy scraper) — the VPS pipeline repo already shows the pattern for that case                                          |
| **3. Runtime-loaded modules** (fetch plugin code from R2/KV, `import()` at runtime)                    | Impossible on Workers (no `eval`/`new Function`; all code uploaded at deploy time) and a security anti-pattern even where possible (untrusted-code problem, cold-path complexity). Decisively closed by the platform                                                                                                                                                                                                                                                                                                                                                                                |
| **4. Hooks-and-filters event bus** (WordPress-style `do_action`/`apply_filter` across core)            | Maximum flexibility, minimum safety: unbounded reach into core and sibling plugins, ordering hazards, and every core change becomes a breaking-change audit across unknown interceptors. Directly contradicts "plugin talks to adapters rather than code". Ports + declared contributions give the same extension points with typed, auditable seams                                                                                                                                                                                                                                                |
| **5. Per-plugin D1 database / full schema isolation** (Strapi's service-per-plugin instincts)          | Multiplies migrations, backups, and deploy surface; cross-household admin surfaces (the audit feed, §3.4) become cross-database queries. Namespaced tables in one DB keep every existing discipline (single `db:migrate` path, EXPLAIN-proven indexes, real-SQL tests) intact                                                                                                                                                                                                                                                                                                                       |

## 6. Compatibility with existing disciplines

- **Additive-nullish contract rule.** The only contract change in Phases A–B is an
  additive, optional `/api/me` field (`enabledPlugins`), following the same discipline as
  `member_id`'s nullability in #399. Its absent-field semantics are specified client-side
  (§4.5): absent = all enabled. Plugin routes enter the same `describeRoute` →
  `bun run api:codegen` → `frontend/openapi.json` → `frontend/src/lib/api-schema.d.ts`
  pipeline; no second contract mechanism is created. The 404-disabled case is described in
  each route's `describeRoute` responses so the generated client's consumers know the
  endpoint can answer "not here" without a transport error.
- **Entitlements.** Plugin gating composes with, and never replaces, `user_plans` →
  `lib/entitlements.ts`: household enablement is a preference (unit: household, fails
  closed), entitlement is a paywall (unit: user, fails to `free`), deployment availability
  is an ops lever (unit: deployment, fails open). Effective access is the conjunction
  (§3.3). No plugin writes `user_plans`, and no entitlement check reads
  `household_plugins`.
- **Migrations.** Forward-only, single sequence: `household_plugins` is a normal numbered
  migration (0023-era; renumber at landing), with an index on `(household_id)` and a
  uniqueness constraint on `(household_id, plugin_id)`; `deployment_flags` is a tiny
  key/value table. No grandfathering backfill is needed — `defaultEnabled` covers existing
  households (§4.3). Plugin tables keep the `<plugin>_` prefix; an uninstall, if ever, is
  itself a forward migration that also clears the plugin's enablement rows. The real-SQL
  migration test pattern (EXPLAIN-proven indexes, `migrations.test.ts`) extends to plugin
  tables at no extra mechanism.
- **Audit logging.** Core records lifecycle events (`plugin_enabled`, `plugin_disabled`,
  `plugin_purged`) in a core-owned table that references households by a **plain handle
  with no FK** — otherwise household deletion cascades it away and "purge record retained"
  is false (§3.4). In-plugin actions keep per-plugin audit tables exactly as
  `document_audit` does today (audit outlives the data it names; no FK to the named row).
  No plugin writes to another plugin's audit trail.
- **Deploy entrypoints.** `scripts/deploy.sh cloudflare` (and `vps` for the pipeline
  service) are untouched: plugins are directory structure inside the existing Worker and
  Pages bundles. Preview Workers for PR branches deploy plugins exactly like any other
  code; branch cleanup is unaffected. The ops kill-switch is **not** a deploy: it is a
  `deployment_flags` row (§3.3), so an incident lever does not require a PR.
- **Tests.** `scripts/test.sh unit` gains the registry-validation, resolver-truth-table,
  and import-boundary suites (the boundary rules ship in ticket 1 with an empty allow-list
  and start policing when the vault moves, ticket 4); the purge job gets an idempotency
  test that kills it mid-chunk and proves resumption. The vault's existing tests migrate
  with its files and keep passing against real SQLite.
- **Documentation.** Phase A updates `docs/ARCHITECTURE.md` — the app list and §10's
  security checklist gain the plugin gate and the ports directory; `docs/API.md` continues
  to come from `./scripts/docs.sh`, never hand-edited.
- **ahaqqu/vps discipline.** Nothing here changes host configuration. When #391's
  DokumenQ adapter lands (Phase D), its env additions go through the vps repo's `rumaq/`
  path per AGENTS.md — this design adds no second bootstrap path.
- **#391 DokumenQ.** Explicitly compatible: the port's shape already anticipates Mode A;
  Mode B is the additive V2 extension (§4.2, §4.7). The plugin boundary narrows DokumenQ's
  blast radius further: swapping adapters touches one plugin directory plus config wiring.

## 7. Proposed follow-up implementation tickets (proposed only — do not create yet)

Ordered; each is one shippable PR-sized unit, gated on owner sign-off of this design. The
boundary rules moved up from last to first: enforcement must exist before the move that it
polices, or the move is reviewed by eye.

1. **Plugin registry core** — manifest types (server + frontend catalog), validation test,
   registry list, plugin **factory** contract, port injection, `household_plugins`
   migration + resolver (`defaultEnabled`), `deployment_flags` + isolate-cached read,
   bootstrap `enabledPlugins` additive payload, gateway dispatch via registry (documents
   registered first), enablement middleware, import-boundary rules with an empty allow-list,
   `ARCHITECTURE.md` update. No frontend change.
2. **Frontend plugin gating** — catalog context provider (refetch on household switch,
   absent field = all enabled), nav filter at all three render sites, route gate + disabled
   empty state, en+id lifecycle strings.
3. **Plugins settings catalog** — owner-only enable/disable with audit events, per-plugin
   copy, capabilities surface (§4.5).
4. **Document vault → plugin move** — re-home `apps/documents.ts` + `lib/documents.ts` under
   `plugins/documents/`, convert to the factory, inject `ports.storage` (removes the three
   `c.env.DOCUMENTS` reads), manifest + catalog contributions, `StorageAdapter` → `ports/`
   move, URL/table/audit contracts unchanged, existing tests migrate green, boundary
   allow-list now actually enforced.
5. **Purge lifecycle** — per-plugin purge job with `purge_state` + cursor, chunked cron
   driver, idempotent per document, bytes-before-rows ordering, owner-only typed
   confirmation, household-dissolution ordering (purge before cascade), core lifecycle audit
   table with no household FK.
6. **Export capability** — per-plugin archive export (zip/CSV), offered before purge;
   deliberately after purge so the destructive path does not wait on export plumbing.
7. **Cron handoff** — plugin-declared scheduled tasks with the `scope` field, per-plugin
   enablement handling, error isolation, and failure audit (the vault needs none today; this
   lands with the first plugin that does).
8. **(After #391 M1/M2) DokumenQ storage adapter** — `DokumenQStorageAdapter` (Mode A)
   behind the unchanged `StorageAdapter` port, env/secret wiring via vps repo discipline,
   adapter-comment invariant update; Mode B (`resolveSignedUrl`) as the additive port V2
   follow-up.

## 8. Open questions for the owner

1. **Default state for new households:** recommend vault **enabled by default**
   (`defaultEnabled: true`). The mechanism no longer depends on the answer — flipping the
   manifest field changes only households that never chose — so decide with the metrics
   (§3.6) rather than before Phase B.
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
   a decision now. Note the purge job makes either cheap: the state machine already has a
   `pending` state a grace timer can hold.
5. **Audit retention at dissolution (new in rev2):** the core lifecycle table must drop the
   household FK to survive deletion (§3.4, §6). That means an opaque household handle is
   retained indefinitely unless a horizon is chosen. Is "purge record retained" satisfied by
   an opaque handle with a retention horizon, and if so, how long? This is a legal answer
   (UU PDP), not a technical one.
6. **Ops kill-switch surface (new in rev2):** `deployment_flags` in D1 (recommended: no new
   binding, fail-open on read error) vs Cloudflare KV vs dashboard env edit. The D1 choice
   makes a liveness decision depend on the database the app is already using — acceptable
   because it fails open, but worth stating explicitly.

## 9. References

- Charter: ahaqqu/RumaQ#400 (owner directive quoted in the status block above); review
  round on PR #401
- Vault MVP: ahaqqu/RumaQ#388 / PR #399 — `backend/src/lib/storage.ts` (`StorageAdapter:27`,
  `buildDocumentKey:40`), `backend/src/apps/documents.ts` (routes at `:103`, auth
  per-path at `:121-123`, adapter construction at `:354,453,498`),
  `backend/src/lib/documents.ts` (`deleteDocument` — bytes before rows),
  `backend/migrations/0022_document_vault.sql`
- Auth/household substrate: `backend/src/auth.ts` (`propsAuthMiddleware:143`,
  `ACTIVE_HOUSEHOLD_SQL:130`, query at `:166`), `backend/src/gateway.ts` (prefix dispatch
  `:65-71`), `backend/src/lib/households.ts` (`requireOwner:116`),
  `backend/src/apps/households.ts`
- Commercial gating: `backend/src/lib/entitlements.ts` (`resolvePlan`, `requireEntitlement`),
  `backend/migrations/0018_user_plans.sql`
- Frontend surfaces: `frontend/src/components/AppShell.jsx` (`navItems:197`, sidebar `:287`,
  drawer `:423`), `frontend/src/routes/`, `frontend/src/i18n/locales/{en,id}.json`,
  contract codegen (`vite.config.ts:68` →
  `scripts/api/generate-openapi-spec.ts` → `frontend/openapi.json` →
  `frontend/src/lib/api-schema.d.ts`)
- Downstream storage swap: ahaqqu/DokumenQ#1 (`docs/DESIGN.md` — Mode A/Mode B adapter
  swap), charter ahaqqu/RumaQ#391
- Prior art sources: cited inline in §1 (Home Assistant contributors docs, Obsidian Help,
  VS Code extension host + API docs, WordPress Plugin Handbook + Wordfence, Backstage docs,
  Strapi docs, Grafana plugin tools docs, Cloudflare Workers runtime docs)
