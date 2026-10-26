import type { GroundingMatch } from './plans.js'

// Deterministic plan price grounding (haqita-integration.md §5.4): fuzzy-match
// a plan item's name against `price_products`, and on a confident match feed
// the latest observed store price back into the plan item. No AI here on
// purpose — the LLM price guess is only ever *overridden* by a rule the tests
// can pin down. Precision over recall: a wrong match shows a wrong price with
// a confident-looking badge.

const GROUND_MIN_CONFIDENCE = 0.8
// Containment of a full normalized name is a strong signal even when the
// extra side carries brand/unit detail ("gula pasir" ⊂ "gula pasir gulaku").
const CONTAINMENT_CONFIDENCE = 0.85
const CONTAINMENT_MIN_CHARS = 4
// Pure quantity/unit tokens ("5", "kg", "1l") carry no identity — dropping
// them from both sides keeps Jaccard focused on product words.
const UNIT_WORDS = new Set([
  'kg',
  'g',
  'gr',
  'gram',
  'l',
  'lt',
  'liter',
  'ml',
  'pcs',
  'pack',
  'bungkus',
  'btl',
  'botol',
  'sachet',
  'butir',
  'ikat',
  'ons',
])

export function normalizeGroundingName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function groundTokens(name: string): string[] {
  return normalizeGroundingName(name)
    .split(' ')
    .filter((token) => token !== '' && !UNIT_WORDS.has(token) && !/^\d+$/.test(token))
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection++
  }
  return intersection / (setA.size + setB.size - intersection)
}

// Pure scoring function (exported for tests): confidence that `item` and
// `product` refer to the same product, 0..1.
export function scoreGroundingMatch(itemName: string, productName: string): number {
  const item = normalizeGroundingName(itemName)
  const product = normalizeGroundingName(productName)
  if (item === '' || product === '') return 0
  if (item === product) return 1
  const shorter = item.length < product.length ? item : product
  const longer = item.length < product.length ? product : item
  // Containment needs a multi-token name: single-word containment ("beras"
  // ⊂ any beras product) is far too weak to ground a price on.
  if (
    shorter.length >= CONTAINMENT_MIN_CHARS &&
    shorter.split(' ').length >= 2 &&
    longer.includes(shorter)
  ) {
    return CONTAINMENT_CONFIDENCE
  }
  return jaccard(groundTokens(item), groundTokens(product))
}

export type GroundedObservation = {
  observationId: string
  price: number
  sourceSlug: string
  sourceName: string
  validUntil: string | null
}

// Latest observation per source for one product, cheapest wins — the estimate
// the plan item shows should be the best current deal.
async function cheapestCurrentObservation(
  db: D1Database,
  productId: string
): Promise<GroundedObservation | null> {
  const row = await db
    .prepare(
      `SELECT o.id, o.price, o.valid_until, s.slug AS source_slug, s.name AS source_name
       FROM price_observations o
       JOIN price_sources s ON s.id = o.source_id
       WHERE o.product_id = ?
         AND o.id = (
           SELECT o2.id FROM price_observations o2
           WHERE o2.product_id = o.product_id AND o2.source_id = o.source_id
           ORDER BY o2.observed_date DESC, o2.scraped_at DESC
           LIMIT 1
         )
       ORDER BY o.price ASC
       LIMIT 1`
    )
    .bind(productId)
    .first<{
      id: string
      price: number
      valid_until: string | null
      source_slug: string
      source_name: string
    }>()
  if (!row) return null
  return {
    observationId: row.id,
    price: row.price,
    sourceSlug: row.source_slug,
    sourceName: row.source_name,
    validUntil: row.valid_until,
  }
}

export async function groundPlanItem(
  db: D1Database,
  name: string
): Promise<(GroundingMatch & { observation: GroundedObservation }) | null> {
  const tokens = groundTokens(name)
  // Longest token is the most distinctive; anchor the prefilter on it.
  const anchor = [...tokens].sort((a, b) => b.length - a.length)[0]
  if (!anchor) return null

  // The token is user input — escape LIKE wildcards so "%"/"_" in an item
  // name cannot widen the prefilter (same treatment as the /api/prices q).
  const pattern = `%${anchor.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
  const { results: candidates } = await db
    .prepare(
      `SELECT id, product_key, name, brand FROM price_products
       WHERE name LIKE ? ESCAPE '\\' OR brand LIKE ? ESCAPE '\\'
       LIMIT 50`
    )
    .bind(pattern, pattern)
    .all<{ id: string; product_key: string; name: string; brand: string | null }>()

  let best: { candidate: (typeof candidates)[number]; confidence: number } | null = null
  for (const candidate of candidates) {
    const confidence = scoreGroundingMatch(name, `${candidate.name} ${candidate.brand ?? ''}`)
    if (confidence >= GROUND_MIN_CONFIDENCE && (!best || confidence > best.confidence)) {
      best = { candidate, confidence }
    }
  }
  if (!best) return null

  const observation = await cheapestCurrentObservation(db, best.candidate.id)
  if (!observation) return null

  return {
    productKey: best.candidate.product_key,
    productName: best.candidate.name,
    confidence: best.confidence,
    observation,
  }
}
