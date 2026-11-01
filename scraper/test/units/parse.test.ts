// Canonical unit normalization (issue #368 phase A). The parse table is
// pinned over REAL catalog names copied verbatim from the 932-entry live
// pull (/tmp/rumaq-taxo/catalog.json, 2026-11-01) — including the owner's
// example pair, the packaging-token families (pck/pch/btl/tpk/klg), the
// multiplier forms ("isi N", "N x M"), comma decimals, and the unparseable
// tail. parseUnit must be pure and total: garbage in → null out, never a
// throw, never a validation failure.

import { describe, expect, it } from 'vite-plus/test'

import { computeUnitPrice, parseUnit } from '../../src/units/parse.js'

describe('parseUnit — unit field first (real catalog entries)', () => {
  it.each([
    // mass → grams
    ['SHUKRIYA BERAS BASMATI PREMIUM SAK 5KG', '5 kg', { qty: 5000, unit: 'g' }],
    ['SO KLIN SOFTERGENT LIQUID PCH 1.45KG (SEMUA JENIS)', '1.45 kg', { qty: 1450, unit: 'g' }],
    ['DAIA DETERGENT BUBUK SOFTENER VIOLET PASSION BAG 2.4KG', '2.4KG', { qty: 2400, unit: 'g' }],
    ['MELON SUPER', '1 kg', { qty: 1000, unit: 'g' }],
    ['KOKOKU BERAS ORGANIK MERAH PCH 2000GR', '2000GR', { qty: 2000, unit: 'g' }],
    ['IKAN SHISAMO PCK 150GR', '150 g', { qty: 150, unit: 'g' }],
    ['Beras Jepang Japonika Astro Goods', '2kg', { qty: 2000, unit: 'g' }],
    ['Fukumi Beras Porang Pouch', '1kg', { qty: 1000, unit: 'g' }],
    // "klg" is a kilogram token in a curated unit field
    ['IKAN TUNA KLG', 'klg', { qty: 1000, unit: 'g' }],
    ['SGM EKSPLOR 1 SUSU PERTUMBUHAN VANILA & MADU', '1.6 kg', { qty: 1600, unit: 'g' }],
    // volume → milliliters (l/ltr/liter, dot and comma decimals)
    ['BIG SOFT DRINK LEMON LIME, STRAWBERRY BTL 1L', '1 L', { qty: 1000, unit: 'ml' }],
    ['FILMA MINYAK GORENG PCH 2L', '2 L', { qty: 2000, unit: 'ml' }],
    ['CLEO AIR MINERAL BTL 1LT', '1 L', { qty: 1000, unit: 'ml' }],
    ['Minyak Goreng Sawit Astro Goods', '2liter', { qty: 2000, unit: 'ml' }],
    ['GENTLE GEN DETERJEN CAIR PCH 1.5L', '1.5 L', { qty: 1500, unit: 'ml' }],
    ['OATSIDE OAT M*LK BARISTA BLEND, CHOCOLATE TPK 1 L', '1 L', { qty: 1000, unit: 'ml' }],
    ['JUNGLE JUICE', '1,5L', { qty: 1500, unit: 'ml' }],
    ['Pewangi pch 1,7L', '1,7L', { qty: 1700, unit: 'ml' }],
    ['BISKUAT Coklat & original', '106,4gr', { qty: 106.4, unit: 'g' }],
    // multiplier forms the live unit fields actually carry
    ['CARNATION KENTAL MANIS SCT 6X38GR', '6 x 38 g', { qty: 228, unit: 'g' }],
    ['AQUA AIR MINERAL BTL 330ML, KARTON ISI : 24 BTL', '24 x 330 ml', { qty: 7920, unit: 'ml' }],
    ['NESCAFE COFFEE ICE ROAST SCT 10X2GR', '10 x 2 g', { qty: 20, unit: 'g' }],
    ['KAPAL API SUPER INSTANT BLACK COFFEE SCT 10X2.2GR', '10 x 2.2 g', { qty: 22, unit: 'g' }],
    ['BEBEK IN-TANK PEMBERSIH TOILET BLUEY TWIN PCK 2X40G', '2 x 40 g', { qty: 80, unit: 'g' }],
    ['MAMA SUKA RUMPUT LAUT PANGGANG', '6 x 4.5 g', { qty: 27, unit: 'g' }],
    [
      'NUSANTARA MADU SUPER, MADUJAE MADU JAHE MERAH DAN SEREH BOX 10X20GR',
      '10 x 20 g',
      { qty: 200, unit: 'g' },
    ],
    ['PAKAIAN DALAM WANITA isi 3', 'isi 3', { qty: 3, unit: 'pcs' }],
    ['SURI Bakso jumbo isi 400gr', '400gr', { qty: 400, unit: 'g' }],
    // count units; bare token in a curated field means one piece
    ['NATURALLY FRESH NANAS KELUD PCS', '1 pcs', { qty: 1, unit: 'pcs' }],
    ['AYAM KAMPUNG ASLI', 'pcs', { qty: 1, unit: 'pcs' }],
    ['AYAM PEJANTAN', 'pcs', { qty: 1, unit: 'pcs' }],
    ["SCHICK QUATTRO TITANIUM KIT 1 PCS, REFILL 4'S", "1 PCS, 4'S", { qty: 1, unit: 'pcs' }],
    [
      'Bundle Beras Setra Ramos Astro Goods 5kg + Minyak Goreng Astro Goods 2liter',
      '1pcs',
      { qty: 1, unit: 'pcs' },
    ],
    ['Ayam Probiotik Utuh Delights Ciken 0.9 - 1.0 kg', '1pcs', { qty: 1, unit: 'pcs' }],
  ])('%s [%s]', (name, unit, expected) => {
    expect(parseUnit(unit, name)).toEqual(expected)
  })
})

describe('parseUnit — name fallback (unit field absent)', () => {
  it.each([
    // packaging tokens stripped: pck/pch/btl/tpk never hide the quantity
    ['IKAN SHISAMO PCK 150GR', { qty: 150, unit: 'g' }],
    ['SUNLIGHT CAIRAN PENCUCI PIRING JERUK NIPIS PCH 1500GR', { qty: 1500, unit: 'g' }],
    ['RINSO DETERGEN BUBUK ANTI NODA PCK 1295GR', { qty: 1295, unit: 'g' }],
    ['ATTACK DETERJEN CAIR MATIC PCH 1200ML', { qty: 1200, unit: 'ml' }],
    ['TIGA SAPI SUSU EVAPORASI TPK 500GR', { qty: 500, unit: 'g' }],
    ['DEL MONTE SPREAD BTL 190GR', { qty: 190, unit: 'g' }],
    // bare "KLG" is a packaging marker in names — 900 g, not 1 kg
    ['APPETON WEIGHT GAIN ADULT CHOCOLATE KLG 900GR', { qty: 900, unit: 'g' }],
    // grammar probe (no live entry carries a numbered KLG): a KLG preceded
    // by a number is not stripped — it keeps meaning kilograms
    ['BERAS PREMIUM 5 KLG', { qty: 5000, unit: 'g' }],
    // brand numbers are not quantities: "02" and "365" skip, the real
    // quantity wins; the leftmost unit-bearing token wins in bundles
    ['SUPER 02 AIR MINUM DENGAN OKSIGEN BTL 385ML', { qty: 385, unit: 'ml' }],
    [
      '365 CHICKEN EGG ROLL PCK 350GR, CHICKEN NUGGET ANIMAL PCK 400GR & CHICKEN KARAAGE PCK 450 GR',
      { qty: 350, unit: 'g' },
    ],
    ['AQUA AIR MINERAL BTL 330ML, KARTON ISI : 24 BTL', { qty: 330, unit: 'ml' }],
    [
      'FRISIAN FLAG SUSU UHT NUTRIBRAIN OMEGA TPK 110ML, KARTON ISI : 40 TPK',
      { qty: 110, unit: 'ml' },
    ],
    // "isi N" without a unit → pieces; "3in1"/"0562" are not quantities
    ['SURI Bakso jumbo isi 400gr', { qty: 400, unit: 'g' }],
    ['PAKAIAN DALAM WANITA isi 3', { qty: 3, unit: 'pcs' }],
    ['3in1 1,5kg', { qty: 1500, unit: 'g' }],
    ['CLARIS TRAVESSA 0562 PCS LARGE, FOODSAVER SQ 2728 ASSORTED PCS', { qty: 1, unit: 'pcs' }],
    ["FAVOUR Character travel pack 60's", { qty: 60, unit: 'pcs' }], // "pack 60"
    // bare count tokens in names mean one piece
    ['IKAN FILLET TILAPIA PCS', { qty: 1, unit: 'pcs' }],
    ['BEBEK PCS', { qty: 1, unit: 'pcs' }],
    // ranges contribute their upper bound
    ['Ayam Probiotik Astro Farm 900-1000gram', { qty: 1000, unit: 'g' }],
  ])('%s', (name, expected) => {
    expect(parseUnit(null, name)).toEqual(expected)
  })

  it.each([
    // the owner's example pair, verbatim semantics
    ['Beras Ramos 1kg', { qty: 1000, unit: 'g' }],
    ['Beras Pandan Wangi 5kg', { qty: 5000, unit: 'g' }],
  ])('owner example: %s', (name, expected) => {
    expect(parseUnit(null, name)).toEqual(expected)
  })

  it('prefers the unit field over the name when both carry a quantity', () => {
    // the name's "5kg + 2liter" must not override the curated pcs unit
    expect(
      parseUnit('1pcs', 'Bundle Beras Setra Ramos Astro Goods 5kg + Minyak Goreng 2liter')
    ).toEqual({
      qty: 1,
      unit: 'pcs',
    })
  })
})

describe('parseUnit — unparseable → null (never a qty, never a throw)', () => {
  it.each([
    // real catalog tail: count markers ("'S"), sizes, bundles, plain names
    ["APEL ROCKIT 2'S PCK", null],
    ['CABE PAPRIKA HIJAU, MERAH, KUNING PCK', null],
    ['Sumo Merah Fortifikasi Khusus Beras Premium', null],
    ["365 BATHROOM TISSUE PCK 2X200'S", null], // "2 x 200's": 'S is out of grammar
    ["HAPPY EGG TELUR OMEGA 10'S PCK", null],
    ['MERRIES BABY DIAPER PANTS BAG M48', null],
    ['IKAN BAWAL HIJAU', null],
  ])('%s', (name, unit) => {
    expect(parseUnit(unit, name)).toBeNull()
  })

  it('returns null for zero, negative, and garbage unit fields', () => {
    expect(parseUnit('0 g', 'Anything')).toBeNull()
    expect(parseUnit('-5 kg', 'Anything')).toBeNull()
    expect(parseUnit('abc', 'Anything')).toBeNull()
    expect(parseUnit('per pack', 'Anything')).toBeNull()
    expect(parseUnit('', 'Anything')).toBeNull()
    expect(parseUnit('   ', 'Anything')).toBeNull()
    expect(parseUnit(null, '')).toBeNull()
    expect(parseUnit(null, '!!!')).toBeNull()
    // a range still contributes its bound, but a lone negative does not
    expect(parseUnit(null, 'Ayam Probiotik Astro Farm 900-1000gram')).toEqual({
      qty: 1000,
      unit: 'g',
    })
  })

  it('is total and deterministic on hostile input', () => {
    const hostile = [
      '',
      '   ',
      null,
      '😀 1 kg',
      'x'.repeat(10_000),
      '1.2.3 kg',
      'kg kg kg',
      '÷×±',
      '2x',
      'x2',
    ]
    for (const unit of hostile) {
      for (const name of ['', 'KG', '😀', 'x'.repeat(10_000), '2 x 2 x 2 g']) {
        const first = parseUnit(unit as string | null, name)
        expect(parseUnit(unit as string | null, name)).toEqual(first)
      }
    }
  })

  // Thermos A1 (PR #372): the number+unit patterns backtrack digit runs, so
  // an unbounded all-digits name degrades quadratically (14s at 50k chars
  // before the cap). scan() bounds its window at MAX_SCAN = 1024 — ~7.7x the
  // longest live catalog name (132 chars); quantities past the window are
  // already best-effort. These assertions complete in milliseconds only
  // while the cap holds.
  it('bounds the scan window on oversized input', () => {
    expect(parseUnit(null, '9'.repeat(50_000))).toBeNull()
    expect(parseUnit(null, '9'.repeat(50_000) + ' kg')).toBeNull()
    expect(parseUnit('9'.repeat(50_000), 'Anything')).toBeNull()
    // within the window the parser still works; past it the tail is dropped
    expect(parseUnit(null, `${'x'.repeat(900)} 5 kg`)).toEqual({ qty: 5000, unit: 'g' })
    expect(parseUnit(null, `${'x'.repeat(2000)} 5 kg`)).toBeNull()
  })
})

describe('computeUnitPrice — listed price per display unit', () => {
  it.each([
    // the owner's example: 550000 / 5 kg → 110000 per kg
    [550000, { qty: 5000, unit: 'g' }, 110000],
    [100000, { qty: 1000, unit: 'g' }, 100000],
    // 36900 / 150 g → 246000 per kg
    [36900, { qty: 150, unit: 'g' }, 246000],
    // rounding to integers
    [10000, { qty: 3, unit: 'pcs' }, 3333],
    [21500, { qty: 2000, unit: 'ml' }, 10750],
    [21500, { qty: 7920, unit: 'ml' }, 2715],
    [0, { qty: 5000, unit: 'g' }, 0],
  ])('%d over %j → %d', (price, parsed, expected) => {
    expect(computeUnitPrice(price, parsed as { qty: number; unit: 'g' | 'ml' | 'pcs' })).toBe(
      expected
    )
  })

  it('returns null when the quantity cannot carry a division', () => {
    expect(computeUnitPrice(36900, { qty: 0, unit: 'g' })).toBeNull()
    expect(computeUnitPrice(36900, { qty: -5, unit: 'g' })).toBeNull()
    expect(computeUnitPrice(Number.NaN, { qty: 5000, unit: 'g' })).toBeNull()
    expect(computeUnitPrice(Number.POSITIVE_INFINITY, { qty: 1000, unit: 'g' })).toBeNull()
  })
})
