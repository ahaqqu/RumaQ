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

## G. Set the EXISTING `LOTTE_PROXY_URL` on the box (lotte-mart Tier-3 proxy)

**PARKED while lotte's site is down** (owner, 2026-11-04). Correction: **no
pipeline PR needed** — the store already declares `proxyEnv: 'LOTTE_PROXY_URL'`
(pipeline `config.ts:144`); the env was simply never set. Empty/absent = the
current by-design skip. Use the same residential-proxy provider as
`HARIHARI_PROXY_URL`; a dedicated endpoint if you want per-store isolation.

- **G1 [VPS]** `ssh rumaq-vps`
- **G2 [VPS]** `sudo -e /etc/rumaq/scraper.env` → add
  `LOTTE_PROXY_URL=<proxy endpoint>`
- **G3 [VPS]** `sudo systemctl restart rumaq-scraper-agent`
- **G4** Next run: no more `BrowserTierRequired … Tier 3` for lotte in
  `journalctl -u rumaq-scraper`; outbox clears.

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
- **E4** https://github.com/ahaqqu/AutQ/pull/9 — AutQ enterprise architecture
  (senior-architect design: Rust IdP on the VPS, SSO via redirects,
  client_credentials m2m, per-app "later + prepare" seams, go/no-go criteria;
  supersedes the obsolete T1–T7 stack). 3 open questions inside — the manager
  will ask them via harness.

## H. Rotate the ingest secret — publish 401 since 2026-11-04 20:00 WIB

**H1–H4 DONE (owner, 2026-11-04 ~23:15 WIB).** Rotation is half-landed: the
Worker now accepts old + new (`_NEXT` = new value), and the box sends the new
value. Remaining:

- **H5 [OWNER — one click, or just wait]** Verify the new secret publishes.
  EITHER open https://rumaq.ahaqqu.com → Admin → Scrape → **Scrape Now**
  (all stores; the publish result lands ~90 min later), OR do nothing —
  tomorrow's 20:00 WIB nightly verifies automatically (the outbox replays
  first). Expect `[publish] Accepted …` in `journalctl -u rumaq-scraper`.
  (Manager note: the Scrape-Now surface is admin-gated beyond the QA test
  account — manager cannot trigger it; that's why this is your click.)
- **H6 [LAPTOP]** Only AFTER a publish is verified accepted — promote:
  `cd ~/Projects/RumaQ` (repo ROOT) →
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

*Last updated 2026-11-04 ~23:35 WIB by the manager. Corrections: the old
action A never completed (wrong `cf` path — the CLI lives at repo root, and
`HAQITA_INGEST_SECRET_NEXT` still exists server-side) — superseded by **H**
(H1–H4 done, H5 verification pending). **G** corrected to the existing
`LOTTE_PROXY_URL` var — no pipeline PR needed; parked while lotte is down.
E3 = DokumenQ AGENTS charter PR (design PR #1 MERGED); **E4** = AutQ
enterprise architecture PR. Completed this window: D1–D5 decisions ✓, F
20:00 WIB schedule verified ✓, DokumenQ §9 8/8 ✓, OCR audit env ✓,
HARIHARI_PROXY_URL ✓, ingest rotation ✓, pipeline CI secrets ✓.*
