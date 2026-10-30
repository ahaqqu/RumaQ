# Haqita → RumaQ Integration — Architecture & Implementation Plan

> Status: **PR1–PR4 merged; go-live (timer enable + first live ingest) pending.** Written 2026-10-24, updated 2026-10-26.
> PR1 (contract & backend) merged as #252, PR2 (scraper scaffold + Superindo + Gemini OCR +
> dry-run publish) merged as #255, PR3 (Lotte Tier-2 + matcher + commit-based VPS deploy,
> VPS scope folded from milestone 4) merged as #262, PR4 (go-live gate: freshness status
> endpoint + smoke staleness alert + `provision-vps.sh --enable-timer`) merged as #275; its
> homepage manifest/doctor change merged as ahaqqu/homepage#13. The box
> bootstrap and host configuration have since moved to `ahaqqu/vps` (`rumaq/`);
> §7 records the retired in-repo bootstrap. 2026-10-26 owner decision: a scraping **monitoring
> admin screen** is wanted — folded into milestones 4 (staleness alert) and 5
> (`price_runs` + admin screen, §7.1). PR6 (haqita cleanup) remains after that.
> 2026-10-26 owner decision: **backfill dropped** — haqita never went live (prototype
> data only), so no data migration: the canonical catalog self-seeds from the first
> real runs and price history accrues from them. `haqita-database` can be archived
> in PR6 once go-live is verified.
> This document is self-contained: a fresh session should be able to implement from it
> without re-exploring the haqita repo. Source references to `/home/ahaqqu/Projects/haqita`
> are included below; that repo still exists locally at time of writing.
> When implementing, follow the `guided-implementation` skill.

## 0. Background

- **RumaQ** (`/home/ahaqqu/Projects/RumaQ`): household grocery inventory assistant.
  Cloudflare Worker (Hono) + D1 (`rumaq`) + R2 (receipts) + Pages (React 19 SPA).
  Has **no external price data model today**; docs already anticipate haqita integration
  (`docs/PROJECT_PLAN.md` "Cheapest-store recommendation", `docs/plan/phase-10-ai-feature-expansion.md`,
  `.commandcode/design/brief.md`).
- **haqita** (`/home/ahaqqu/Projects/haqita`, github.com/ahaqqu/haqita): Jakarta grocery
  price comparison, ~23k lines. Pipeline: scrape promo **brochure images** from 2 stores
  (Lotte Mart, Superindo) → Gemini vision OCR → 7-gate cross-store product matching →
  publish to Cloudflare Pages (haqita.pages.dev, D1 `haqita-db`, R2 `haqita-images`).
  No scheduler — manual runs. Big deletable surface (web UI, own REST API, 917-line
  deploy.py, 787-line sync_cloudflare.py, git-as-database repo, 651-line haqita.sh,
  agentic harness).
- **VPS** (`/home/ahaqqu/Projects/homepage/provision/vps/MACHINE.md`): 2 vCPU / 4 GB
  Debian, nginx + systemd per-app pattern, **no Docker**, disk is the scarce resource,
  "no app trusts another app" (no shared DBs). New services follow the per-repo
  `provision/vps/` runbook. CI deploys as `kajianq-deploy` with scoped sudoers.
  Bun already runs on the box (kajianq).

## 1. Locked decisions (user-approved 2026-10-24)

| Decision                  | Choice                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| RumaQ v1 features powered | **Plan price grounding + Price explorer UI** (cheapest-store rec and price alerts out of scope for v1)            |
| haqita fate               | **Headless data service** — delete web UI, its REST API, haqita-database git repo                                 |
| Language                  | **TypeScript on Bun** (rewrite; user chose over trimmed-Python)                                                   |
| Communication             | **Push**: scraper POSTs daily snapshots to a service-authed RumaQ ingest endpoint                                 |
| Quality gate              | **Auto-publish** with `match_confidence`; RumaQ filters by threshold; rejected/low-confidence items logged on VPS |
| Cadence                   | **Daily ~06:00 Asia/Jakarta** (23:00 UTC)                                                                         |
| Future stores             | Alfamart, Indomaret, Transmart/Hypermart/AEON, **Astro** → pluggable `StorePlugin` interface is mandatory         |

## 2. Where the scraper runs (anti-scraping answer)

**On the VPS**, as a systemd timer service with **no inbound ports**, using a
**per-store fetch-strategy ladder**:

1. **Tier 1 — plain fetch**: realistic Chrome headers/cookies (Superindo works today;
   JSON/API sources like Astro / Alfamart-Indomaret catalogs will use this).
2. **Tier 2 — headless Chromium (Playwright)**: for JS-challenged sites (Lotte is behind
   Imperva Incapsula). A real browser executing the challenge usually passes regardless
   of datacenter IP — main mitigation for the EU Netcup egress IP.
3. **Tier 3 — per-store proxy**: store-scoped `HTTP_PROXY` (cheap residential proxy or
   ID egress) if a specific store still blocks the VPS IP.

Rejected alternatives: GitHub Actions (shared US datacenter IPs — worst Incapsula
profile, cron drift); home machine (best IP, no reliable scheduler); Cloudflare cron
(datacenter-flagged IPs, forces everything onto CF).

**Fail-fast gate: validate Lotte reachability from the VPS in Milestone 2, before
porting the matcher.**

## 3. Whole-system architecture

```
   lottemart.co.id  superindo.co.id      (future: alfamart/indomaret/transmart/astro)
          │ brochure pages / catalog JSON
          ▼
┌─ VPS (rumaq-scraper, systemd timer 23:00 UTC = 06:00 WIB, no inbound ports) ─┐
│  scraper/ package (TypeScript/Bun, RumaQ monorepo workspace member)         │
│   stores/     plugin per store: strategy plain|browser, brochure|catalog     │
│   fetch/      strategy ladder + novelty state (url-hash, min 50KB/300px)     │
│   ocr/        Gemini vision (ported prompt) + Gemini verifier                │
│   match/      7 gates ported to TS; embeddings via Gemini embedding API      │
│               (drops torch/sentence-transformers); canonical-catalog match   │
│   publish/    POST snapshot → RumaQ ingest (bearer secret, retries)          │
│   state/      /var/lib/rumaq-scraper (novelty, embedding cache, logs)        │
└──────────────────────────│──────────────────────────────────────────────────┘
                           │ HTTPS push, daily, idempotent, schemaVersion: 1
                           ▼
┌─ Cloudflare ────────────────────────────────────────────────────────────────┐
│  RumaQ Worker (existing Hono, D1 `rumaq`)                                    │
│   NEW  POST /api/internal/ingest/prices   bearer HAQITA_INGEST_SECRET        │
│   NEW  GET  /api/prices?q=&source=        explorer search (auth'd user)      │
│   NEW  GET  /api/prices/:productKey       detail + per-store + history       │
│   MOD  POST /api/plans/generate           post-hoc price grounding of items  │
│   D1   price_sources / price_products / price_observations (migration 0007)  │
│  RumaQ Pages (React SPA)                                                     │
│   NEW  /prices explorer page; plan items show grounded-estimate badge        │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Framing**: RumaQ's Worker remains _the_ backend. The scraper is a headless data
producer — zero inbound HTTP on the VPS (no nginx conf, no cert, no port).

## 4. Language pros/cons (decision record)

- **TypeScript/Bun** ✅ (chosen) — one toolchain across RumaQ + scraper; ingest contract
  is a single shared Valibot schema; bun already proven on the VPS; Playwright is
  first-class TS. Cost: matcher/scrapers re-implemented (bounded: gates are ~500 lines
  of pure functions with an existing test suite to port).
- **Python (trim)** — least effort/risk (proven code, 368 tests), but two toolchains
  forever, duplicated contract across languages, torch dependency (≈GB) on a
  disk-scarce VPS.
- **Go** — cheapest ops (static binary), but full rewrite AND no shared contract types
  with a TS backend.
- **Rust** — most robust, highest rewrite cost, slowest iteration when supermarket HTML
  changes (it will).

## 5. RumaQ backend changes

### 5.1 Migration `backend/migrations/0007_price_data.sql`

Global tables (NOT household-scoped):

```sql
CREATE TABLE IF NOT EXISTS price_sources (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,          -- 'lotte-mart', 'superindo', 'alfamart', ...
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'supermarket',
  region TEXT NOT NULL DEFAULT 'jakarta',
  website TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_products (
  id TEXT PRIMARY KEY,
  product_key TEXT UNIQUE NOT NULL,   -- slug '{name}--{brand}--{unit}' (haqita convention)
  name TEXT NOT NULL,
  brand TEXT,
  unit TEXT,
  category TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS price_observations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES price_products(id),
  source_id TEXT NOT NULL REFERENCES price_sources(id),
  observed_date TEXT NOT NULL,        -- YYYY-MM-DD
  price INTEGER NOT NULL,             -- IDR
  effective_unit_price REAL,
  promo_type TEXT,                    -- bundle_buy|get_free|discount_pct|...
  promo_label TEXT,
  valid_from TEXT,
  valid_until TEXT,
  match_method TEXT,                  -- exact|embedding|ai|solo
  match_confidence REAL NOT NULL,
  brochure_url TEXT,                  -- deep-link to store's original brochure page
  scraped_at TEXT NOT NULL,
  UNIQUE (product_id, source_id, observed_date)
);
CREATE INDEX IF NOT EXISTS idx_obs_product ON price_observations(product_id);
CREATE INDEX IF NOT EXISTS idx_obs_valid ON price_observations(valid_until);

ALTER TABLE plan_items ADD COLUMN price_observation_id TEXT REFERENCES price_observations(id);
```

No R2 for brochure images in v1 — observations link back to the store's public
brochure URL (`brochure_url`). Keeps the scraper credential-free.

### 5.2 Ingest endpoint

`POST /api/internal/ingest/prices`

- Mounted **before / exempt from** the global rate-limit middleware
  (`backend/src/apps/api.ts` — the `apiApp.use('*', ...)` IP limiter near the top) and
  from `propsAuthMiddleware`.
- Auth: `Authorization: Bearer ${HAQITA_INGEST_SECRET}` (new secret; add to
  `backend/src/types.ts` Env and the `put_worker_secrets` step in `scripts/deploy.sh`,
  which uploads via `cf workers secrets update`).
  Timing-safe compare.
- Payload (single shared Valibot schema — see §6; defined once, imported by both sides):

```jsonc
{
  "schemaVersion": 1,
  "scrapedAt": "2026-10-24T23:00:05Z",
  "stores": [{ "slug": "lotte-mart", "name": "Lotte Mart", "website": "...", "region": "jakarta" }],
  "items": [
    {
      "productKey": "minyak-goreng--bimoli--1-l",
      "name": "Minyak Goreng Bimoli",
      "brand": "Bimoli",
      "unit": "1 L",
      "category": null,
      "storeSlug": "lotte-mart",
      "price": 21500,
      "effectiveUnitPrice": 21500,
      "promoType": "discount_pct",
      "promoLabel": "Diskon 15%",
      "validFrom": "2026-10-22",
      "validUntil": "2026-10-28",
      "matchMethod": "exact",
      "matchConfidence": 1.0,
      "brochureUrl": "https://www.lottemart.co.id/...",
    },
  ],
}
```

- Handler: upsert stores & products (by slug / product_key), then idempotent
  `INSERT ... ON CONFLICT(product_id, source_id, observed_date) DO UPDATE` per item.
- Response: `{ accepted, productsCreated, observationsUpserted, skipped }`.
- Excluded from user-facing hono-openapi docs (internal route).

### 5.3 Explorer endpoints (user-facing, behind `propsAuthMiddleware`)

- `GET /api/prices?q=&source=` — latest observation per product per source; return
  items with confidence ≥ 0.55 (flag low-confidence in payload); sort by relevance/price.
- `GET /api/prices/:productKey` — product detail + per-source current prices +
  full history (for trend chart).
- Cache headers: `public, max-age=3600` pattern like `/api/health` (prices are not
  per-user). Note: these sit behind session auth, so confirm interplay with the
  `CachedApi` edge-cache export during implementation.
- Regenerate `docs/API.md` via `scripts/docs.sh` (CI gate checks the diff).

### 5.4 Plan price grounding (`backend/src/lib/plans.ts`, `/api/plans/generate`)

- After the LLM returns plan items, **deterministically** fuzzy-match each item name
  against `price_products` (SQL LIKE prefilter + JS token scoring using
  `normalizeItemName`-style normalization; confidence ≥ 0.8 required).
- On confident match: set `price_estimate` from the observation (override the LLM
  guess) and store `price_observation_id` on the `plan_items` row.
- Optional (cheap): prepend a compact "current promo top-20" digest into
  `buildPlanPrompt` so the LLM can bias suggestions toward deals.
- Plans GET joins the observation so the frontend can show a badge:
  "estimasi dari brosur Lotte Mart, valid s/d 28 Okt".

## 6. Scraper package (`scraper/`, new Bun workspace member)

```
scraper/
  package.json            deps: cheerio, playwright-core (+bundled chromium), @google/genai,
                          valibot, (dev) vitest — NO torch/sklearn/numpy
  src/main.ts             pipeline scrape→ocr→match→publish; stage-status JSON files (resume);
                          exit codes; structured logs
  src/config.ts           port of haqita config.yaml thresholds + per-store strategy table
  src/stores/types.ts     StorePlugin interface — two capabilities:
                          brochure: listBrochureIssues() → page image URLs
                          catalog:  listItems() → structured items directly (Astro, Alfamart/Indomaret)
  src/stores/superindo.ts port of scripts/scrapers/superindo.py (cheerio; jabodetabek filter) — plain fetch
  src/stores/lotte.ts     port of scripts/scrapers/lotte.py — browser tier (Incapsula)
  src/stores/index.ts     registry
  src/fetch/strategy.ts   ladder: plain(headers+cookie jar) → playwright headless
                          (realistic UA/viewport, waits) → store-scoped proxy via env
  src/fetch/state.ts      novelty detection: URL+MD5 state.json; min 50KB / 300px filters
  src/ocr/gemini.ts       @google/genai; port prompt from haqita scripts/ocr/prompts/gemini.py;
                          JSON items {name, brand, unit, price, promo[], period}; quota-aware retry
  src/ocr/verify.ts       port AI_PROMPT_TEMPLATE from matcher.py (YES/NO pair verifier)
  src/match/normalize.ts  port normalizer.py (canonical_tokens, normalize_brand, token_overlap,
                          units_type/value_compatible)
  src/match/promo.ts      port matching/promo_parser.py (~584 lines)
  src/match/gates.ts      gates 0–5 as pure functions (unit_type, brand, token_jaccard [0.30],
                          exact, embedding [auto ≥0.85 / low <0.55], price plausibility [3.0×])
  src/match/embedding.ts  Gemini embedding API (replaces paraphrase-multilingual-MiniLM-L12-v2)
                          + on-disk embedding cache in state dir
  src/match/matcher.ts    ★ KEY CHANGE: match each store's items against the growing CANONICAL
                          CATALOG (scales to N stores; old code was lotte×superindo pairwise).
                          Unmatched confident items found the catalog.
  src/publish/payload.ts  THE shared Valibot IngestPayload schema (imported by backend)
  src/publish/client.ts   POST to RUMAQ_INGEST_URL with bearer RUMAQ_INGEST_SECRET;
                          retry/backoff; --dry-run mode (write payload to state dir)
  src/util/               log, retry, image helpers
  scripts/run.sh          single-shot pipeline (systemd timer + manual use)
  provision/vps/          apply.sh (idempotent bootstrap), rumaq-scraper.service
                          (Type=oneshot, MemoryMax=1G, CPUQuota=100%), rumaq-scraper.timer
                          (OnCalendar 23:00 UTC), logrotate stanza
  test/                   port relevant pytest suites (scrapers/matching/ocr/payload/publish);
                          copy HTML/image fixtures from haqita data/test/
```

Ported thresholds (from haqita `config.yaml`): `token_jaccard_min: 0.30`,
`embedding_auto_match: 0.85`, `embedding_ambiguous_low: 0.55`,
`unit_tolerance_pct: 15`, `price_ratio_max: 3.0`; OCR model `gemini-3.5-flash`
(+ verifier `gemini-2.5-flash`), or whatever the current models are at implementation
time.

**Deleted from haqita** (do not port): web UI + Pages Functions API, deploy.py,
sync_cloudflare.py, seed_d1.py, haqita.sh, git-database auto-commit, agentic
harness, review queue/admin UI (replaced by `rejected-items.log` in the VPS state
dir). Images pruned 7 days after successful publish (disk-scarce box).

### 6.1 Astro catalog store (implemented 2026-10-28)

Astro is the first `catalog`-kind store (§6's "structured items directly"
capability — no brochure images, no Gemini OCR). Investigation findings, all
probed live on 2026-10-28:

- **Source**: category pages on `www.astronauts.id` server-render page 0 of
  the listing (30 items) with the full inventory API response embedded as raw
  JSON inside the Next.js flight stream (`self.__next_f.push([1,"…"])`).
- **Why not the API**: every direct call to `api.astronauts.id` is gated by an
  app-version check (`error_code EC1001`, "Aplikasi kamu perlu di-update
  dulu") plus an `X-DEVICE-ID` device fingerprint header. The web bundle
  hardcodes the version headers (`X-API-VERSION: 1.9.11`,
  `X-APP-VERSION: android-2.17.1`, `X-DEVICE: web-customer`,
  `X-DEVICE-VERSION: 3.4.10`), but replaying them still trips the gate — so
  the plugin scrapes the SSR route instead, which needs no headers beyond the
  Tier-1 defaults. `?page=1` is ignored server-side; 30 items per category is
  the v1 coverage.
- **Extraction**: product objects are located _structurally_ — the API's key
  order varies between responses (one fetch orders `variantRelativeProductIds`
  first, the next puts it mid-object), so a first-key anchor silently returns
  0 items. The parser does one string-aware brace scan and resolves each
  `variantRelativeProductIds` occurrence to its innermost enclosing object.
- **Category pages** (the three RumaQ v1 staples): beras
  (`kebutuhan-pokok-2721/beras-lokal-5858` + `beras-import-5859`), minyak
  goreng (`kebutuhan-pokok-2721/minyak-goreng-25060`), daging ayam
  (`ayam-unggas-7179/ayam-parting-7181` + `ayam-utuh-7182`).
- **Category override**: `ASTRO_CATEGORY_PAGES` (comma-separated full URLs,
  same shape as Lotte's `LOTTE_URL`) swaps the page list without a redeploy —
  full URLs because the parent category segment is required (`/c/beras-lokal-5858`
  404s). Only `astronauts.id` hosts are accepted and an override with no valid
  entries falls back to the defaults; `maxPages` still caps the count. Note
  Astro has no leaflet-style image brochure — promos are per-product in the
  inventory JSON (captured above) or client-rendered campaign pages
  (`/promo/…`) without the embedded JSON, so the catalog parser cannot read
  them.
- **Promo mechanics per product**, mapped to the ingest contract:
  - _inventory discount_: `product_discount_price` (post-discount, becomes
    the item's `price`) + `product_discount_percentage` → promo label
    "Diskon 8%" → `parsePromo` → `discount_pct`, effective unit price = the
    discounted price. Quota-limited (`product_discount_stock`,
    `product_discount_daily_quota`) — not surfaced; the observed price is
    what the customer pays.
  - _tier discount_: `inventory_discount_tier_label` ("Beli 2 Disc.4%" with
    the per-unit `final_price` at that qty) → kept as promo label text only.
    It is conditional on buying N units; the observed "Disc.%" phrasing
    matches no `parsePromo` pattern, so it stays `single` (no effective unit
    price). A tier label phrased like a standard promo ("Beli 2 Gratis 1")
    would claim its math — the same treatment OCR'd conditional brochure
    promos get, not a special guarantee.
  - _vouchers_: `voucher_labels` exist but are empty on category listings in
    practice — not mapped.
  - `product_grammation_label` ("5kg", "450-550gram") becomes `unit`; the
    listing carries only a numeric `brandId`, so `brand` is null.

## 7. VPS operations (host config now lives in `ahaqqu/vps`)

> The authoritative units, timer, deploy contract, deploy identity's grant and
> env templates live in `ahaqqu/vps` `rumaq/` (`docs/DEPLOY.md`,
> `docs/ACCESS.md`). The bullets below record the original in-repo bootstrap;
> its scripts (`scraper/provision/vps/`, `scripts/provision-vps.sh`) were
> retired when the scraper deploy switched to `vps-deploy rumaq`.

- System user `rumaq-scraper`; code rsynced to `/srv/rumaq-scraper`;
  state in `/var/lib/rumaq-scraper`; secrets root-only in `/etc/rumaq-scraper/env`
  (KajianQ pattern: `GEMINI_API_KEY`, `RUMAQ_INGEST_URL`, `RUMAQ_INGEST_SECRET`,
  optional per-store proxy vars).
- `rumaq-scraper.timer` at 23:00 UTC (= 06:00 WIB). No nginx, no cert, no listener.
  The unit pins the zone in `OnCalendar=*-*-* 23:00:00 UTC` — without the suffix
  systemd reads the time in the box's local zone (Europe/Berlin).
- CI deployed as the shared `kajianq-deploy` with a scoped sudoers rule for
  `systemctl restart rumaq-scraper`; it now deploys as `rumaq-deploy` through
  `sudo -n /usr/local/sbin/vps-deploy rumaq`.
- RumaQ `scripts/deploy.sh` gains a `vps` mode (build + upload + `vps-deploy`). **Add every new
  shell script to `.gitattributes` with `mode=755`** (CI requirement).
- `scripts/test.sh unit scraper` → new vitest project in root `vite.config.ts`.
- homepage repo PR: MACHINE.md app-table row + card; doctor.sh awareness (timer unit).
- **Operator bootstrap**: retired — `scraper/provision/vps/` and
  `scripts/provision-vps.sh` are gone. Install the host configuration with the
  `ahaqqu/vps` applier, then append this repository's key to the `rumaq-deploy`
  identity (`ahaqqu/vps` `docs/DEPLOY.md` § Bootstrap order). The nightly timer
  and `RUMAQ_PUBLISH=true` are already live and are never reset by a deploy.

### 7.1 Monitoring (owner decision 2026-10-26: admin screen wanted)

Today (PR3): the only monitoring surfaces are on the box — journald per-run logs and
exit codes (0/1/2), `status.json` in the state dir (structured last-run summary incl.
per-store errors), `rejected-items.log`, pending outbox files as the publish-failure
tell, and the post-deploy self-check. Nothing notifies anyone when the nightly run
fails, and the app has no visibility into runs.

Planned, in two parts:

- **Staleness alert (go-live, milestone 4)**: the existing 6-hourly smoke workflow
  additionally checks price-data freshness — latest `price_observations` newer than
  7 days (168h) — reusing its auto-created `smoke-failure` issue on failure. The
  7-day threshold is deliberate (owner decision 2026-10-27): one failed nightly run
  is not "service down" — the scraper logs it (journal + status.json) and the
  timer retries the next night (the systemd unit exits 0 and stays green);
  only a week of consecutive failures means the pipeline is actually broken. Catches
  every failure mode end-to-end (box down, timer off, scrape error, publish error).
- **Scraping monitor screen (milestone 5, folded into the frontend PR)**:
  the pipeline reports each run to the backend (`price_runs` table via an
  internal ingest endpoint: started/finished, exit code, per-store pages/items/errors,
  match stats, publish result), and the frontend gains an admin-only scraping
  monitor — run history with success/failure state, per-run detail, last-success age.
  Logs themselves stay in journald (linked from the run detail as instructions).

## 8. Milestones → PRs

Never commit directly to main; use PRs (`pr-creation` skill); GitHub Actions must be
green before merge. Suggested sequence:

1. **PR1 — Contract & backend**: migration 0007; ingest endpoint + unit tests;
   `GET /api/prices` + `GET /api/prices/:productKey` + tests; `HAQITA_INGEST_SECRET`
   wiring (types.ts, deploy put-secrets); `scripts/docs.sh` regen.
2. **PR2 — Scraper scaffold + Superindo**: scraper package, config, Tier-1 fetch,
   superindo plugin, novelty state, Gemini OCR client + ported prompt, publish client
   (dry-run), tests + fixtures. **Includes first VPS reachability check for Lotte**
   (fail-fast gate for Tier 2 decision).
3. **PR3 — Lotte + matcher + VPS deploy**: Playwright Tier-2 strategy, lotte plugin, full matcher
   port (canonical catalog, Gemini embeddings, verifier). Port pytest fixtures
   verbatim; diff-test old Python outputs vs new TS on the same inputs before cutover.
   Plus (folded from milestone 4, 2026-10-25): `scraper/provision/vps/` (apply.sh, units,
   sudoers, env example), `scripts/deploy.sh vps` → `scripts/deploy/vps.sh` (bundle → rsync →
   chromium → self-check → doctor), commit-based `deploy-vps` CI job gated on `vars.VPS_HOST`,
   `--self-check` CLI. Timer ships installed-but-disabled; enabling is go-live (milestone 4).
   Box bootstrap is `scripts/provision-vps.sh` (§7).
4. **PR4 — Go-live**: homepage MACHINE.md/doctor PR, `apply.sh --enable-timer` +
   `RUMAQ_PUBLISH=true` (exposed as `scripts/provision-vps.sh --enable-timer`), first
   successful live ingest into prod D1 (manual run on the box), **smoke staleness check**
   (§7.1 — implemented as `GET /api/internal/prices/status` + a freshness step in the
   6-hourly smoke workflow; it skips while no observations exist so merging it does not
   red-flag smoke pre-go-live). Backfill dropped 2026-10-26 (owner decision: haqita
   never went live — prototype data only).
5. **PR5 — Frontend + scraping monitor**: `/prices` explorer (TanStack Router file route, page in
   `frontend/src/pages/`, api fns in `lib/api.js`, TanStack Query hooks in
   `lib/queries/`, i18n id/en); plan grounding logic + `price_observation_id` join;
   grounded-estimate badge on plan items; tests per FRONTEND_CONVENTIONS.md.
   **Plus the monitoring screen (§7.1, owner decision 2026-10-26)**: `price_runs`
   table + run-report endpoint (contract + scraper + backend), admin-only scraping
   monitor page (run history, per-run detail, last-success age).
6. **PR6 — Cleanup**: archive github.com/ahaqqu/haqita + haqita-database (after
   go-live is verified); delete Cloudflare haqita Pages project / D1 `haqita-db` /
   R2 `haqita-images`; update RumaQ docs (PROJECT_PLAN, phase-10 references).

## 9. Risks & mitigations

| Risk                            | Mitigation                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Incapsula vs EU datacenter IP   | Browser tier + per-store proxy; validated in PR2 before matcher port                                            |
| Playwright on 2 vCPU / 4 GB     | Serial page fetches, `MemoryMax=1G`, few dozen pages/day                                                        |
| Gemini OCR/verifier quota drift | Novelty state (no re-OCR), per-store `max_pages` guard, quota-aware retry (port `QuotaExhaustedError` behavior) |
| Matcher regression in TS port   | Port fixtures verbatim; diff old-vs-new outputs on identical inputs                                             |
| Contract drift                  | Single shared Valibot schema in monorepo; additive-only changes; `schemaVersion`                                |
| D1 growth                       | ~tens of thousands of rows/year — trivial; no pruning initially                                                 |

## 10. Estimated size

scraper ≈ 2–2.5k lines TS + ported tests; backend ≈ +600 lines; frontend ≈ +500
lines. The ~23k-line haqita is replaced by a producer an order of magnitude smaller.

## 11. Key source references (haqita repo, for porting)

| Target (scraper/)                  | Port from (haqita)                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/stores/superindo.ts`          | `scripts/scrapers/superindo.py`                                                                  |
| `src/stores/lotte.ts`              | `scripts/scrapers/lotte.py` (+ `base_scraper.py` headers/retry)                                  |
| `src/ocr/gemini.ts`                | `scripts/ocr/prompts/gemini.py`, `scripts/ocr/gemini_client.py`, `scripts/common/http_client.py` |
| `src/match/gates.ts`, `matcher.ts` | `scripts/matching/matcher.py` (gate fns + AI_PROMPT_TEMPLATE)                                    |
| `src/match/promo.ts`               | `scripts/matching/promo_parser.py`                                                               |
| `src/match/normalize.ts`           | `scripts/matching/normalizer.py`                                                                 |
| `src/config.ts`                    | `config.yaml`                                                                                    |
| fixtures                           | `data/test/` (HTML + images), `tests/` (matching/ocr/scrapers suites)                            |

RumaQ touch-points (updated after the tech-stack tidy-up landed, #241-#244:
single Worker serves app + API from one origin — no Pages, no PAGES_ORIGIN;
frontend API client is `frontend/src/lib/api.ts` built on openapi-fetch with
`frontend/src/lib/api-schema.d.ts` regenerated by `vp run api:codegen` — new
routes must regenerate it or CI fails; deploy runs the cf CLI with
`backend/cloudflare.config.ts`, no wrangler TOMLs): `backend/migrations/0007_price_data.sql`,
`backend/src/apps/api.ts` (route registration, rate-limit exemption, auth-middleware
pattern), `backend/src/types.ts`, `backend/src/lib/plans.ts`,
`backend/src/schemas.ts` (+ declare the new route's query/body metadata in
describeRoute so the typed client picks it up), `scripts/deploy.sh` + `scripts/deploy/`,
`scripts/test.sh`, root `vite.config.ts`, `.gitattributes`, `frontend/src/routes/`,
`frontend/src/pages/`, `frontend/src/lib/api.ts`, `frontend/src/lib/queries/`,
`frontend/src/i18n/`, `docs/API.md` (regenerated).
