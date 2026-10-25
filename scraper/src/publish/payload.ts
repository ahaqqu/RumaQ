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

import type { IngestItem, IngestPayload } from '@rumaq/contract'
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
  return month ? `${year}-${month}-${String(day).padStart(2, '0')}` : null
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
        observedDate: input.scrapedAt.slice(0, 10),
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
