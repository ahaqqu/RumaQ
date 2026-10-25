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
import { parsePeriod, parsePromo } from '../match/promo.js'
import type { MatchOutcome } from '../match/matcher.js'

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

export { parsePeriod }

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
 * Build the ingest payload. Promo math (effectiveUnitPrice/promoType) is
 * the ported promo parser; identity fields come from the matcher's outcome
 * for each product — the canonical catalog key when matched, the item's own
 * key when it founded an entry (matchMethod 'solo': no cross-store identity
 * claim is being made, so its confidence is trivially 1.0).
 */
export function buildPayload(input: {
  stores: StoreConfig[]
  images: ImageProducts[]
  scrapedAt: string
  /** Matcher outcome per product object (identity-keyed). */
  outcomes?: Map<ValidatedProduct, MatchOutcome>
}): IngestPayload {
  const items: IngestItem[] = []
  for (const image of input.images) {
    // Per-batch observed date: replayed batches keep the date of the run
    // that OCR'd them (the upsert conflict key includes observed_date), so
    // a cross-day replay hits the same row instead of inserting duplicates.
    const observedDate = (image.scrapedAt ?? input.scrapedAt).slice(0, 10)
    for (const product of image.products) {
      const [validFrom, validUntil] = parsePeriod(product.period)
      const promo = parsePromo(product.promo, product.price)
      const outcome = input.outcomes?.get(product)
      items.push({
        productKey:
          outcome?.productKey ?? makeProductKey(product.name, product.brand, product.unit),
        name: product.name,
        brand: product.brand ?? null,
        unit: product.unit ?? null,
        category: null,
        storeSlug: image.storeSlug,
        price: product.price,
        effectiveUnitPrice: promo.promoType === 'single' ? null : promo.effectiveUnitPrice,
        promoType: promo.promoType === 'single' ? null : promo.promoType,
        promoLabel: product.promo ? product.promo.join('; ') : null,
        validFrom,
        validUntil,
        observedDate,
        matchMethod: outcome?.matchMethod ?? 'solo',
        matchConfidence: outcome?.matchConfidence ?? 1.0,
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
