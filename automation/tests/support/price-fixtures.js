// Shared price fixtures for the API feature suite (tests/local/api/steps/
// prices.steps.js) and the e2e explorer suite (tests/local/e2e/steps/
// prices-explorer.steps.js). Both suites assert against the same data, so
// the builders live here once — the promo snapshot encodes the exact
// raw-vs-effective price disagreement the sort, detail, and grounding
// assertions depend on.

export const OIL_KEY = 'minyak-goreng--bimoli--1-l'
export const RICE_KEY = 'beras--pandan-wangi--5-kg'
export const SUGAR_KEY = 'gula-pasir--gulaku--1-kg'
export const COFFEE_KEY = 'kopi--kapal-api--165-g'

export function priceSnapshot() {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-24T23:00:05Z',
    stores: [
      { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
      { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
    ],
    items: [
      {
        productKey: OIL_KEY,
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        storeSlug: 'lotte-mart',
        price: 21500,
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: OIL_KEY,
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        storeSlug: 'superindo',
        price: 23000,
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: RICE_KEY,
        name: 'Beras Pandan Wangi 5 kg',
        brand: 'Pandan Wangi',
        unit: '5 kg',
        storeSlug: 'superindo',
        price: 72000,
        matchMethod: 'embedding',
        matchConfidence: 0.7,
      },
    ],
  }
}

// Second snapshot one day later: adds two products where raw-price order and
// effective-price order disagree. Gula Pasir: the raw-cheapest store is
// Lotte (40000 < 41000) but the effective-cheapest is Superindo (36000 < 38000)
// — the exact case the sort and grounding fix must get right.
export function promoSnapshot() {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-25T23:00:05Z',
    stores: [
      { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
      { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
    ],
    items: [
      {
        productKey: SUGAR_KEY,
        name: 'Gula Pasir Gulaku 1 kg',
        brand: 'Gulaku',
        unit: '1 kg',
        storeSlug: 'lotte-mart',
        price: 40000,
        effectiveUnitPrice: 38000,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 5%',
        validFrom: '2026-10-25',
        validUntil: '2026-11-05',
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: SUGAR_KEY,
        name: 'Gula Pasir Gulaku 1 kg',
        brand: 'Gulaku',
        unit: '1 kg',
        storeSlug: 'superindo',
        price: 41000,
        effectiveUnitPrice: 36000,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 12%',
        validFrom: '2026-10-25',
        validUntil: '2026-10-30',
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
      {
        productKey: COFFEE_KEY,
        name: 'Kopi Kapal Api 165 g',
        brand: 'Kapal Api',
        unit: '165 g',
        storeSlug: 'lotte-mart',
        price: 30000,
        validUntil: '2026-10-29',
        matchMethod: 'exact',
        matchConfidence: 1.0,
      },
    ],
  }
}

export function bulkCatalogueSnapshot(count) {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-26T23:00:05Z',
    stores: [{ slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' }],
    items: Array.from({ length: count }, (_, i) => ({
      productKey: `bulk-item-${i}--acme--1-pcs`,
      name: `Bulk Item ${i}`,
      brand: 'Acme',
      unit: '1 pcs',
      storeSlug: 'lotte-mart',
      price: 1000 + i * 7,
      matchMethod: 'exact',
      matchConfidence: 1.0,
    })),
  }
}
