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
export const FLOUR_KEY = 'tepung--segitiga-biru--1-kg'

// Servable brochure object URLs (issue #293): the per-image grouping keys of
// the brochures view. Dated by the snapshot's scrape date; the round-trip and
// sweep scenarios upload the corresponding R2 objects explicitly.
export const BROCHURE_PAGE_LOTTE = '/api/brochures/lotte-mart/20261024/page_1_2ad1c95b.jpg'
export const BROCHURE_KORAN_SUPERINDO = '/api/brochures/superindo/20261024/koran_a_1b2c3d4e.jpg'
// Indomaret's rendered-PDF page (issue #322): the same servable shape, PNG
// content type — OCR-flow parity proof for the render path.
export const BROCHURE_PALINGMURAH_INDOMARET =
  '/api/brochures/indomaret/20261024/PalingMurah-29Okt-page-01_a1b2c3d4.png'

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
        // Promo evidence for the promos catalog (issue #292): oil sits on
        // discount_pct at TWO stores — the count-parity fixture's
        // double-count hazard (2 evidence rows, 1 distinct product).
        promoType: 'discount_pct',
        promoLabel: 'Diskon 15%',
        matchMethod: 'exact',
        matchConfidence: 1.0,
        // Brochure object URLs (issue #293): every OCR'd page gets its own
        // relative same-origin URL — oil and flour share Lotte's page 1.
        brochureUrl: BROCHURE_PAGE_LOTTE,
      },
      {
        productKey: OIL_KEY,
        name: 'Minyak Goreng Bimoli',
        brand: 'Bimoli',
        unit: '1 L',
        storeSlug: 'superindo',
        price: 23000,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 15%',
        matchMethod: 'exact',
        matchConfidence: 1.0,
        brochureUrl: BROCHURE_KORAN_SUPERINDO,
      },
      {
        productKey: RICE_KEY,
        name: 'Beras Pandan Wangi 5 kg',
        brand: 'Pandan Wangi',
        unit: '5 kg',
        storeSlug: 'superindo',
        price: 72000,
        promoType: 'get_free',
        promoLabel: 'Beli 1 gratis 1',
        matchMethod: 'embedding',
        matchConfidence: 0.7,
        brochureUrl: BROCHURE_KORAN_SUPERINDO,
      },
      {
        // Label but no promo_type: the Other bucket's input (issue #292).
        // High price + no validity + "T" name so the sort scenarios append
        // it after the existing products instead of reshuffling them.
        productKey: FLOUR_KEY,
        name: 'Tepung Segitiga Biru 1 kg',
        brand: 'Segitiga Biru',
        unit: '1 kg',
        storeSlug: 'lotte-mart',
        price: 80000,
        promoLabel: 'Beli 2 gratis 1',
        matchMethod: 'exact',
        matchConfidence: 1.0,
        brochureUrl: BROCHURE_PAGE_LOTTE,
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

// Alfamart's campaign page deep link (issue #322): catalog items carry the
// CAMPAIGN URL, not a servable /api/brochures/ object — the brochure view
// must never group them (no OCR flow ever rendered a page image).
export const ALFAMART_PROMO_PAGE =
  'https://alfagift.id/promo/Murah-Banget-30-Oktober---5-November-2026'

// Catalog-store fixture (issue #322): alfamart items land straight from the
// rendered DOM — no OCR, no brochure object — with a parsed discount_pct
// promo and a tier promo that stays label-only (the astro convention).
export function catalogSnapshot() {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-26T23:00:05Z',
    stores: [{ slug: 'alfamart', name: 'Alfamart', region: 'jakarta' }],
    items: [
      {
        productKey: 'minyak-goreng--filma--2-l',
        name: 'Minyak Goreng Filma Pouch 2 L',
        brand: 'Filma',
        unit: '2 L',
        storeSlug: 'alfamart',
        price: 43700,
        promoType: 'discount_pct',
        promoLabel: 'Diskon 5%',
        matchMethod: 'solo',
        matchConfidence: 1.0,
        brochureUrl: ALFAMART_PROMO_PAGE,
      },
      {
        productKey: 'detergen-cair--gentle-gen--700-g',
        name: 'Detergen Cair Gentle Gen 700 g',
        brand: 'Gentle Gen',
        unit: '700 g',
        storeSlug: 'alfamart',
        price: 25000,
        promoLabel: 'Beli 2 Disc.4%',
        matchMethod: 'solo',
        matchConfidence: 1.0,
        brochureUrl: ALFAMART_PROMO_PAGE,
      },
    ],
  }
}

// Brochure listing fixture (issue #293): items over the two servable object
// URLs above, plus one legacy retailer-page URL row (the pre-#293 data shape)
// that the servable-shape predicate must exclude from every group. Issue
// #322 adds an indomaret rendered-PNG page: a store whose pages never came
// from a plain image download must group exactly like the OCR stores.
export function brochureSnapshot() {
  return {
    schemaVersion: 1,
    scrapedAt: '2026-10-26T23:00:05Z',
    stores: [
      { slug: 'indomaret', name: 'Indomaret', region: 'jakarta' },
      { slug: 'lotte-mart', name: 'Lotte Mart', region: 'jakarta' },
      { slug: 'superindo', name: 'Superindo', region: 'jakarta' },
    ],
    items: [
      {
        productKey: 'susu-uht--ultra--1-l',
        name: 'Susu UHT Ultra 1 L',
        brand: 'Ultra',
        unit: '1 L',
        storeSlug: 'lotte-mart',
        price: 19000,
        matchMethod: 'exact',
        matchConfidence: 1.0,
        brochureUrl: BROCHURE_PAGE_LOTTE,
      },
      {
        productKey: 'roti-tawar--sari-roti--1-bungkus',
        name: 'Roti Tawar Sari Roti',
        brand: 'Sari Roti',
        unit: '1 bungkus',
        storeSlug: 'lotte-mart',
        price: 14000,
        matchMethod: 'exact',
        matchConfidence: 1.0,
        // Legacy retailer-page URL: never servable, never in a group.
        brochureUrl: 'https://www.lottemart.co.id/brosur',
      },
      {
        productKey: 'sabun-mandi--lifebuoy--1-bks',
        name: 'Sabun Mandi Lifebuoy',
        brand: 'Lifebuoy',
        unit: '1 bks',
        storeSlug: 'superindo',
        price: 5000,
        matchMethod: 'exact',
        matchConfidence: 1.0,
        brochureUrl: BROCHURE_KORAN_SUPERINDO,
      },
      {
        productKey: 'gula-pasir--gulaku--1-kg',
        name: 'Gula Pasir Gulaku 1 kg',
        brand: 'Gulaku',
        unit: '1 kg',
        storeSlug: 'indomaret',
        price: 15500,
        matchMethod: 'exact',
        matchConfidence: 1.0,
        brochureUrl: BROCHURE_PALINGMURAH_INDOMARET,
      },
    ],
  }
}
