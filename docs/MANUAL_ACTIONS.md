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

## B. Hari-Hari PAS cold-start backfill — **DECLINED by owner 2026-11-06**

Owner: "i don't want to do B." The manual backfill is off the table. The
replacement path is the Apify research (ahaqgu/RumaQ#411): if free-tier Apify
is adopted for Hari-Hari (X), the current PAS period's history becomes a
one-time automated deep fetch instead of a manual save-and-ingest — and B
retires. Until that decision, hari-hari stays thin (guest-window only,
green-skip semantics).

## C. Categorize activation `RUMAQ_CATEGORY` shadow → on (time-gated ~2026-11-15, #396 §5)

Do NOT start before ~2026-11-15 (audit weeks 1–2 must complete first) and
only on your explicit go. Replay-backfill also needs your explicit go.

- **C1 [VPS]** `ssh rumaq-vps`
- **C2 [VPS]** `sudo -e /etc/rumaq/scraper.env` → set `RUMAQ_CATEGORY=on`
- **C3 [VPS]** `sudo systemctl restart rumaq-scraper-agent`
- **C4 [VPS]** `systemctl status rumaq-scraper-agent --no-pager | head -5` → active

## E. Review + merge owner-gate PRs [LAPTOP]

Workflow rule: these are workflow/design PRs — always merged by you, never by
the manager, even when you're AFK.

- **E1** https://github.com/ahaqqu/RumaQ/pull/403 — QA workflow docs
  (docs/QA.md + AGENTS.md line + docs/MANUAL_ACTIONS.md). CI green.
- **E2** https://github.com/ahaqqu/RumaQ/pull/401 — plugin architecture
  design (north star — execution is standalone-first per owner decision
  2026-11-04). CI green.
  _(E4 AutQ enterprise architecture — merged by the owner 2026-11-05. H —
  ingest secret rotation — DONE: owner promoted the primary + deleted `_NEXT`
  2026-11-05; verified green by the manager's publish checks. J —
  YOGYA_PROXY_URL — DONE 2026-11-05.)_

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

## L. Agent 401 storm evidence (drift recurrence — ahaqqu/RumaQ#448)

The nightly itself was clean (20:00–20:38 WIB Nov 5, `Result=success` exit 0 —
publish accepted), but the box agent logged **1,962 consecutive
`scrape/next → HTTP 401` poll failures, 19:40 WIB Nov 5 → 03:51 WIB Nov 6**,
self-healing at 03:55 WIB with **no restart, no deploy, no env change** —
deploy-wise nothing sits between #420 (Nov 4 22:41 UTC) and #427 (Nov 5
21:55 UTC); the storm runs strictly between them. Publish uses the SAME
`requireIngestSecret` middleware + secrets (api.ts:232) and stayed green
inside the window. Full analysis: ahaqqu/RumaQ#448.

- **L1 [LAPTOP]** Cloudflare dashboard → Workers & Pages → `rumaq-api` →
  **Version history**: confirm there was no deploy between 2026-11-04 22:41
  UTC and 2026-11-05 21:55 UTC. Then Workers Logs (if retained): any
  exceptions during 2026-11-05 12:40–20:55 UTC.
- **L2 [VPS]** `ssh rumaq-vps` → `systemctl cat rumaq-scraper-agent.service | grep -i env`
  — which env file feeds the agent vs the nightly's `/etc/rumaq/scraper.env`
  (a second, stale secret file is theory #1, though it cannot explain the
  self-heal).
- **L3 [VPS]** `ssh rumaq-vps` → `journalctl -u systemd-timesyncd --since "2026-11-05 19:00" --until "2026-11-06 04:00"`
  and `timedatectl` — clock-stepping events near either storm boundary
  (skew theory).

---

_Last updated 2026-11-06 ~07:4x WIB by the manager. Completed: **E3** (strategy
report merged by owner — lives at `docs/reports/competitor-analysis-2026-11.html`),
**E4** (Nov 5), **H6/H7** (rotation finalized Nov 5), **J** (YOGYA_PROXY_URL
Nov 5), **G** (LOTTE_PROXY_URL set Nov 6 — site still down; temporary source
swap tracked in ahaqqu/RumaQ-pipeline#25), **K** (nightly 401 incident —
verified green; #425 closed), **B** (declined by owner — Apify research #411
is the replacement path). Remaining: **C**
(~Nov 15), **I** (prompt review), **L** (agent 401 storm evidence — #448). E5 (#432 hooks) merged by owner 2026-11-06 —
pre-commit `vp check --fix` is live on every clone after `bun install`._
