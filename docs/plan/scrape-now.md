# Scrape Now — admin-triggered, store-selectable scraping with live logs

Status: SHIPPED and live (2026-10-28 plan, merged PRs #315/#322 era). **Moved**: the scraper side of this plan (agent, pipeline, store plugins, VPS deploys) now lives in the private [RumaQ-pipeline](https://github.com/ahaqqu/RumaQ-pipeline) repo — the tree moved there verbatim on 2026-11-03 (ahaqqu/RumaQ#376, provenance commit `34884be` from `ahaqqu/RumaQ@eefe3f4a`). Host configuration remains in `ahaqqu/vps` `rumaq/`.

RumaQ keeps the app side: the `/admin/scrape` page and queue UI, the D1 command queue and run-report ingest endpoints (`backend/src/lib/scrape.ts`, `backend/src/lib/price-runs.ts`), and the `@rumaq/contract` schemas. The full original plan (scraper agent, store plugins, provisioning history) moved verbatim to the pipeline repo's `docs/plan/scrape-now.md`.
