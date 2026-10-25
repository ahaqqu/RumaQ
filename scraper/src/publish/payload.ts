// The ingest payload builder. The schema itself lives in the @rumaq/contract
// workspace package (single shared definition — PR1) and is re-exported here
// as the scraper-side import point (docs/plan/haqita-integration.md §5.2/§6).

export {
  ingestPayloadSchema,
  ingestStoreSchema,
  ingestItemSchema,
  type IngestPayload,
  type IngestStore,
  type IngestItem,
} from '@rumaq/contract'

import { safeParse } from 'valibot'

import { ingestPayloadSchema, type IngestItem, type IngestPayload } from '@rumaq/contract'
import type { StoreConfig } from '../config.js'
import type { ValidatedProduct } from '../ocr/parse.js'

/** Stable, URL-safe product key — port of haqita make_product_key. */
export function makeProductKey(name: string, brand: string | null, unit: string | null): string {
  const slug = (value: string | null) =>
    value
      ?.toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') ?? ''
  return `${slug(name)}--${slug(brand)}--${slug(unit)}`
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  mei: '05',
  jun: '06',
  jul: '07',
  agu: '08',
  sep: '09',
  okt: '10',
  nov: '11',
  des: '12',
  may: '05',
  aug: '08',
  oct: '10',
  dec: '12',
}

function toIsoDate(day: number, monthStr: string, year: string): string | null {
  const month = MONTHS[monthStr.toLowerCase().slice(0, 3)]
  if (!month) return null
  // OCR digits can be impossible ("45 Mei", "30 Feb"): round-trip through
  // Date UTC so only dates that actually exist are emitted — the schema's
  // regex checks the YYYY-MM-DD shape only.
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, day))
  const exists =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === day
  return exists ? `${year}-${month}-${String(day).padStart(2, '0')}` : null
}

/**
 * Parse an OCR'd period string into (validFrom, validUntil) ISO dates.
 * Port of haqita promo_parser.parse_period — full promo typing lands with
 * the matcher port in PR3.
 */
export function parsePeriod(period: string | null | undefined): [string | null, string | null] {
  if (!period) return [null, null]

  // Range: "7 - 20 Mei 2026", "14-17 Mei 2026", "Berlaku 1-15 Mei 2026"
  const range = /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+(\w+)\s+(\d{4})/.exec(period)
  if (range) {
    return [
      toIsoDate(Number(range[1]), range[3]!, range[4]!),
      toIsoDate(Number(range[2]), range[3]!, range[4]!),
    ]
  }

  // Single end date: "s/d 20 Mei 2026", "sd. 20 Mei 2026", "sampai/until ..."
  const until = /(?:s[/.]?d|sampai|until)\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i.exec(period)
  if (until) {
    return [null, toIsoDate(Number(until[1]), until[2]!, until[3]!)]
  }

  // Bare single date: "20 Mei 2026"
  const single = /(\d{1,2})\s+(\w+)\s+(\d{4})/.exec(period)
  if (single) {
    return [null, toIsoDate(Number(single[1]), single[2]!, single[3]!)]
  }

  return [null, null]
}

export interface ImageProducts {
  storeSlug: string
  /** Brochure listing page the items were OCR'd from. */
  brochureUrl: string | null
  products: ValidatedProduct[]
  /**
   * ISO scrapedAt of the run that extracted these items. Outbox lines carry
   * it so a cross-day replay keeps the original observed date — the ingest
   * upsert's conflict key includes observed_date, so replaying with the
   * replay day's date would insert duplicate observation rows. Current-run
   * batches leave it unset and buildPayload falls back to the run's
   * scrapedAt; legacy outbox lines without the field do the same.
   */
  scrapedAt?: string
}

/**
 * Build the ingest payload. Until the canonical-catalog matcher lands
 * (PR3), every item is published with matchMethod 'solo' and confidence 1.0
 * — the auto-publish quality gate (§1): RumaQ filters by threshold.
 */
export function buildPayload(input: {
  stores: StoreConfig[]
  images: ImageProducts[]
  scrapedAt: string
}): IngestPayload {
  const items: IngestItem[] = []
  for (const image of input.images) {
    // Per-batch observed date: replayed batches keep the date of the run
    // that OCR'd them (the upsert conflict key includes observed_date), so
    // a cross-day replay hits the same row instead of inserting duplicates.
    const observedDate = (image.scrapedAt ?? input.scrapedAt).slice(0, 10)
    for (const product of image.products) {
      const [validFrom, validUntil] = parsePeriod(product.period)
      items.push({
        productKey: makeProductKey(product.name, product.brand, product.unit),
        name: product.name,
        brand: product.brand ?? null,
        unit: product.unit ?? null,
        category: null,
        storeSlug: image.storeSlug,
        price: product.price,
        effectiveUnitPrice: null,
        promoType: null,
        promoLabel: product.promo ? product.promo.join('; ') : null,
        validFrom,
        validUntil,
        observedDate,
        matchMethod: 'solo',
        matchConfidence: 1.0,
        brochureUrl: image.brochureUrl,
      })
    }
  }

  const storeSlugsInUse = new Set(items.map((item) => item.storeSlug))
  return {
    schemaVersion: 1,
    scrapedAt: input.scrapedAt,
    stores: input.stores
      .filter((store) => storeSlugsInUse.has(store.slug))
      .map((store) => ({
        slug: store.slug,
        name: store.name,
        region: store.region,
        website: store.website ?? null,
      })),
    items,
  }
}

/**
 * Validate a built payload against the shared schema before it leaves the
 * producer: a contract violation is a pipeline bug and must fail the run
 * here, not surface as an ingest rejection (or bad D1 data) in the Worker.
 */
export function assertPayloadValid(payload: IngestPayload): void {
  const result = safeParse(ingestPayloadSchema, payload)
  if (!result.success) {
    throw new Error(
      `Ingest payload failed schema validation: ${result.issues
        .map((issue) => `${issue.path?.map((p) => String(p.key)).join('.')}: ${issue.message}`)
        .join('; ')}`
    )
  }
}
