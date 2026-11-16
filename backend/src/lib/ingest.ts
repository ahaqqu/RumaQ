// The payload schema lives in the @rumaq/contract workspace package
// (runtime-agnostic) so the scraper imports it as a real dependency;
// re-exported here for existing callers.
export {
  ingestStoreSchema,
  ingestItemSchema,
  ingestPayloadSchema,
  runReportSchema,
  reviewItemPairSchema,
  type IngestPayload,
  type IngestStore,
  type IngestItem,
  type RunReport,
  type ReviewItemPair,
} from '@rumaq/contract'
export type PricesStatus = {
  latestObservedDate: string | null
  latestScrapedAt: string | null
  observationCount: number
}

// Freshness summary for the CI smoke staleness check (§7.1): the smoke
// workflow alerts when the nightly pipeline stops landing observations.
// latestObservedDate is the publish signal (a run that scrapes but never
// publishes leaves it behind); count=0 means go-live has not happened yet.
export async function getPricesStatus(db: D1Database): Promise<PricesStatus> {
  const row = await db
    .prepare(
      `SELECT MAX(observed_date) AS latest_observed_date,
              MAX(scraped_at) AS latest_scraped_at,
              COUNT(*) AS observation_count
       FROM price_observations`
    )
    .first<{
      latest_observed_date: string | null
      latest_scraped_at: string | null
      observation_count: number
    }>()

  return {
    latestObservedDate: row?.latest_observed_date ?? null,
    latestScrapedAt: row?.latest_scraped_at ?? null,
    observationCount: row?.observation_count ?? 0,
  }
}
