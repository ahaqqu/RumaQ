# MANUAL_ACTIONS — everything waiting on the owner

Maintained by the manager. **To report status, just reply in chat**, e.g.
`A done, C3 failed — <error>` — the manager updates this file (done items are
removed, failed steps stay with the error noted). Empty file = inbox zero.

Conventions:
- Every step is absolute (explicit `cd` or absolute path) and labeled
  **[LAPTOP]** (this machine) or **[VPS]** (the box `62.83.35.220`, ssh alias
  `rumaq-vps`).
- **Never deploy by hand**: merging a PR auto-deploys production (code + D1
  migrations) via CI. There is no manual deploy step.
- When a ticket/finding needs an owner action, the manager adds it here with
  the next free letter ID and links that ID in the ticket.
- Steps you execute yourself: root-only env files (`/etc/rumaq/scraper.env`)
  are yours alone — the manager never reads or writes them.

---

## B. Hari-Hari PAS cold-start backfill (one-time, #396 §2)

History deeper than the 5-tweet guest window is never auto-fetched — the
current PAS period's catalog pages must be provided manually once.

- **B1 [LAPTOP]** Open the store's own Instagram/Facebook/X and locate the
  current PAS-period catalog posts/pages.
- **B2 [LAPTOP]** Save those catalog pages (images/PDFs) locally.
- **B3 [LAPTOP]** Follow the backfill ingestion per ahaqqu/RumaQ#396 §2 (the
  ticket documents the scope: current period only). If the exact ingestion
  command isn't documented to your liking, say so and the manager will write
  B3 out concretely against the pipeline's admin tooling.

## C. Categorize activation `RUMAQ_CATEGORY` shadow → on (time-gated ~2026-11-15, #396 §5)

Do NOT start before ~2026-11-15 (audit weeks 1–2 must complete first) and
only on your explicit go. Replay-backfill also needs your explicit go.

- **C1 [VPS]** `ssh rumaq-vps`
- **C2 [VPS]** `sudo -e /etc/rumaq/scraper.env` → set `RUMAQ_CATEGORY=on`
- **C3 [VPS]** `sudo systemctl restart rumaq-scraper-agent`
- **C4 [VPS]** `systemctl status rumaq-scraper-agent --no-pager | head -5` → active

## G. Set `LOTTEMART_PROXY_URL` on the box (#412 — per-store proxy for Lotte)

**WAIT for my go in chat first** (the pipeline PR must land; until then the
env is simply unused). Reuses the `HARIHARI_PROXY_URL` mechanism — same
residential-proxy provider; take a dedicated endpoint if you want per-store
isolation.

- **G1 [VPS]** `ssh rumaq-vps`
- **G2 [VPS]** `sudo -e /etc/rumaq/scraper.env` → add
  `LOTTEMART_PROXY_URL=<proxy endpoint>` (exact var name confirmed when the
  pipeline PR lands)
- **G3 [VPS]** `sudo systemctl restart rumaq-scraper-agent`
- **G4** On the next nightly (or a Scrape-Now): lotte outbox clears — no more
  `BrowserTierRequired … Tier 3` for lotte in `journalctl -u rumaq-scraper`

## E. Review + merge owner-gate PRs [LAPTOP]

Workflow rule: these are workflow/design PRs — always merged by you, never by
the manager, even when you're AFK.

- **E1** https://github.com/ahaqqu/RumaQ/pull/403 — QA workflow docs
  (docs/QA.md + AGENTS.md line + docs/MANUAL_ACTIONS.md). CI green.
- **E2** https://github.com/ahaqqu/RumaQ/pull/401 — plugin architecture
  design (north star — execution is standalone-first per owner decision
  2026-11-04). CI green.
- **E3** https://github.com/ahaqqu/DokumenQ/pull/2 — DokumenQ AGENTS.md
  charter (§9 Q8 decision: secrets-discipline rules before any code PR).
  (Design PR DokumenQ#1 was MERGED 2026-11-04 with owner approval.)

## H. Rotate the ingest secret — publish 401 since 2026-11-04 20:00 WIB

Tonight's nightly (first on the 20:00 schedule) died at the LAST step:
`PublishRejected: Ingest endpoint rejected credentials (HTTP 401)` — the
Worker-side ingest secret no longer matches the box's `RUMAQ_INGEST_SECRET`
(auth code unchanged, no deploys in between; likely fallout of the unfinished
old action A — `_NEXT` still exists server-side, so "empty text = unset" was
wrong). **~89 min of scraping (incl. alfamart 1034 items) is safe in the
outbox and replays automatically once this is fixed.** Zero-downtime via the
dual-accept window (Worker accepts primary + `_NEXT`, #376):

- **H1 [LAPTOP]** Generate a fresh secret (e.g. `openssl rand -base64 32`).
  Never paste it into chat or any file the manager reads.
- **H2 [LAPTOP]** `cd ~/Projects/RumaQ` (repo ROOT — `cf` lives at
  `node_modules/cf/bin/cf` there, **not** `backend/`) →
  `node node_modules/cf/bin/cf workers secrets update HAQITA_INGEST_SECRET_NEXT --worker api --type secret_text --text '<NEW VALUE>'`
  (Worker now accepts old + new).
- **H3 [VPS]** `ssh rumaq-vps` → `sudo -e /etc/rumaq/scraper.env` → set
  `RUMAQ_INGEST_SECRET=<NEW VALUE>`
- **H4 [VPS]** `sudo systemctl restart rumaq-scraper-agent`
- **H5** Tell me when done — I verify with ONE Scrape-Now and expect
  `[publish] Accepted …` in the journal.
- **H6 [LAPTOP]** Only after H5 verifies: promote —
  `node node_modules/cf/bin/cf workers secrets update HAQITA_INGEST_SECRET --worker api --type secret_text --text '<NEW VALUE>'`
- **H7 [LAPTOP]** Then remove the redundant one:
  `node node_modules/cf/bin/cf workers secrets delete HAQITA_INGEST_SECRET_NEXT --worker api`

## I. Review the AI prompts (owner review — pipeline repo)

All AI prompts live in **ahaqqu/RumaQ-pipeline** (the scraper moved there in
RumaQ #387). There are exactly **two** prompts; nothing else calls an LLM —
astro/alfamart/tip-top parse structured HTML (no OCR), and categorize is a
rules + name-hash-cache classifier (no prompt text).

- **I1 — OCR extraction prompt** (Gemini vision). Shared body + a per-store
  first line for the 6 brochure stores (superindo, lotte-mart, hypermart,
  indomaret, hari-hari, yogya):
  https://github.com/ahaqqu/RumaQ-pipeline/blob/main/groceries/scraper/src/ocr/gemini.ts#L20-L55
  - Output shape demanded: ONLY a JSON array — `name`, `brand`, `unit`,
    `price` (integer IDR, "Rp 8.500" → 8500, never per-unit), `promo` texts,
    `period`, plus `originalPrice` (rule added in #367).
  - Price-semantics rules: discounted vs original (red-font heuristic,
    "not always"), both prices never in `promo`.
  - Accuracy AFTER the model: strict JSON parse + price validation —
    `price_missing` vs `price_invalid` (raw price embedded in the reason; e.g.
    2026-11-03's `INDOMIE Mi Goreng — price_invalid: 0`):
    https://github.com/ahaqqu/RumaQ-pipeline/blob/main/groceries/scraper/src/ocr/parse.ts#L129-L145
    Rejections are logged with reasons in status.json + the run report.
  - Shadow OCR audit (#367) replays pages through a mirrored prompt and diffs
    the two: https://github.com/ahaqqu/RumaQ-pipeline/blob/main/groceries/scraper/src/ocr/audit.ts
- **I2 — match verifier prompt** (Gemini, ONE binary call per borderline
  pair): same brand + variant + size → YES; different brand/variant/pack size
  → NO; OCR typos do not differentiate; unparseable/failed → null → the pair
  is flagged for review, never silently guessed:
  https://github.com/ahaqqu/RumaQ-pipeline/blob/main/groceries/scraper/src/ocr/verify.ts#L18-L30
- Both prompts carry in-code **"load-bearing — change deliberately, not
  casually"** warnings (ported verbatim from haqita). If you want wording
  changes, mark the line and I'll run it through the store fixtures + shadow
  audit before merging.

---

*Last updated 2026-11-04 ~23:15 WIB by the manager. Corrections: the old
action A never completed (wrong `cf` path — the CLI lives at repo root, and
`HAQITA_INGEST_SECRET_NEXT` still exists server-side) — superseded by **H**.
E3 replaced: DokumenQ design PR #1 MERGED (owner-approved, §9 resolved 8/8);
E3 is now the AGENTS.md charter PR. Completed this window: D1–D5 decisions ✓
(epoch / guest approved / persona parked / Apify GO / lotte per-store proxy),
F 20:00 WIB schedule verified ✓, OCR audit env ✓, HARIHARI_PROXY_URL ✓,
ingest rotation ✓, pipeline CI secrets ✓.*
