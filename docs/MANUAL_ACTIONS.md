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
  (docs/QA.md + AGENTS.md line). CI green.
- **E2** https://github.com/ahaqqu/RumaQ/pull/401 — plugin architecture
  design (per-household recommendation, 8 proposed follow-up tickets). CI green.
- **E3** https://github.com/ahaqqu/DokumenQ/pull/1 — DokumenQ design doc
  (signed-URL flow, migration runbook, 8 open questions to answer).

---

*Last updated 2026-11-04 ~07:45 WIB by the manager. Completed this window
(no longer listed): D1–D5 decisions recorded on tickets ✓ (session epoch /
guest approved / persona parked / Apify GO / lotte per-store proxy), A secret
cleanup ✓, F 20:00 WIB schedule verified ✓, OCR audit env ✓,
HARIHARI_PROXY_URL ✓, ingest rotation ✓, pipeline CI secrets ✓, production
deploy of the vault ✓ (CI auto-deploy).*
