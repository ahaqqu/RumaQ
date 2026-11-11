import { describe, expect, it } from 'vite-plus/test'
import { safeParse } from 'valibot'

import {
  apiErrorSchema,
  canonicalIndexSchema,
  ingestItemSchema,
  ingestItemV2Schema,
  ingestPayloadV2Schema,
  ingestReceiptSchema,
  ingestSizeSchema,
  validateIngestV2,
} from '@rumaq/contract'
import validIndex from '../../../contract/fixtures/valid/canonical-index.json'
import validIngest from '../../../contract/fixtures/valid/ingest-v2.json'
import validReceipt from '../../../contract/fixtures/valid/ingest-receipt.json'
import badStatus from '../../../contract/fixtures/invalid/index-bad-status.json'
import missingId from '../../../contract/fixtures/invalid/receipt-missing-product-id.json'
import missingRawName from '../../../contract/fixtures/invalid/ingest-missing-raw-name.json'
import undeclaredStore from '../../../contract/fixtures/invalid/ingest-undeclared-store.json'
import unknownField from '../../../contract/fixtures/invalid/ingest-unknown-field.json'
import v1 from '../../../contract/fixtures/invalid/ingest-v1.json'

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('pipeline contract v2', () => {
  it('accepts the valid ingest fixture and its store declarations', () => {
    expect(safeParse(ingestPayloadV2Schema, validIngest).success).toBe(true)
    expect(validateIngestV2(validIngest).success).toBe(true)
  })

  it('rejects a v1 payload', () => {
    expect(safeParse(ingestPayloadV2Schema, v1).success).toBe(false)
  })

  it('rejects unknown fields', () => {
    expect(safeParse(ingestPayloadV2Schema, unknownField).success).toBe(false)
  })

  it('rejects a missing raw name', () => {
    expect(safeParse(ingestPayloadV2Schema, missingRawName).success).toBe(false)
  })

  it('rejects an undeclared store with a path to the item', () => {
    const result = validateIngestV2(undeclaredStore)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.issues[0]?.path).toEqual(['items', 0, 'storeSlug'])
    }
  })

  it('accepts the valid receipt and canonical index fixtures', () => {
    expect(safeParse(ingestReceiptSchema, validReceipt).success).toBe(true)
    expect(safeParse(canonicalIndexSchema, validIndex).success).toBe(true)
  })

  it('rejects a receipt with a non-zero skipped count', () => {
    const receipt = copy(validReceipt)
    receipt.skipped = 1
    expect(safeParse(ingestReceiptSchema, receipt).success).toBe(false)
  })

  it('rejects a receipt without a product id', () => {
    expect(safeParse(ingestReceiptSchema, missingId).success).toBe(false)
  })

  it('rejects an unknown product status', () => {
    expect(safeParse(canonicalIndexSchema, badStatus).success).toBe(false)
  })

  it('accepts the shared error envelope', () => {
    expect(
      safeParse(apiErrorSchema, {
        error: 'Validation failed',
        issues: [{ path: ['items', 3, 'rawName'], message: 'Expected a string' }],
      }).success
    ).toBe(true)
  })
})

// Issue #627 part 1: memberPrice is the member/app price beside the shelf
// `price`. Additive-nullish on BOTH ingest schemas — an old producer without
// the field keeps validating, and the bounds are the same money rules as
// `price` (non-negative integer).
describe('member price contract (#627)', () => {
  const v1Item = {
    productKey: 'minyak-goreng--bimoli--1-l',
    name: 'Minyak Goreng Bimoli',
    brand: null,
    unit: null,
    category: null,
    storeSlug: 'lotte-mart',
    price: 21500,
    matchConfidence: 1,
  }
  const v2Item = {
    productKey: 'minyak-goreng--bimoli--1-l',
    rawName: 'MINYAK GORENG BIMOLI 1 L',
    rawBrand: null,
    rawUnit: null,
    category: null,
    taxoVersion: null,
    storeSlug: 'lotte-mart',
    price: 21500,
    matchConfidence: 1,
  }

  it('accepts an integer member price on both schemas', () => {
    expect(safeParse(ingestItemSchema, { ...v1Item, memberPrice: 19900 }).success).toBe(true)
    expect(safeParse(ingestItemV2Schema, { ...v2Item, memberPrice: 19900 }).success).toBe(true)
    // The parsed output carries the field (it is not silently dropped).
    const v2 = safeParse(ingestItemV2Schema, { ...v2Item, memberPrice: 19900 })
    expect(v2.success && v2.output.memberPrice).toBe(19900)
  })

  it('accepts null and absent member prices (old payloads keep validating)', () => {
    for (const item of [v1Item, v2Item]) {
      const schema = item === v1Item ? ingestItemSchema : ingestItemV2Schema
      expect(safeParse(schema, { ...item, memberPrice: null }).success).toBe(true)
      expect(safeParse(schema, item).success).toBe(true)
    }
  })

  it('rejects a negative member price on both schemas', () => {
    expect(safeParse(ingestItemSchema, { ...v1Item, memberPrice: -1 }).success).toBe(false)
    expect(safeParse(ingestItemV2Schema, { ...v2Item, memberPrice: -1 }).success).toBe(false)
  })

  it('rejects a fractional member price on both schemas', () => {
    expect(safeParse(ingestItemSchema, { ...v1Item, memberPrice: 19900.5 }).success).toBe(false)
    expect(safeParse(ingestItemV2Schema, { ...v2Item, memberPrice: 19900.5 }).success).toBe(false)
  })
})

// Pipeline #116: the observation carries the identity slice of the product's
// size — one pack in the base unit + packCount — separate from the unit-price
// totals in `unitQty`/`unitQtyUnit`. Additive-nullish on the v2 schema: an old
// payload (no field) keeps validating, a new payload hitting an old Worker
// fails loudly (strictObject, Worker-first).
describe('ingest size contract (#116)', () => {
  const v2Item = {
    productKey: 'fitmee-beras-porang----1kg',
    rawName: 'Fitmee Beras Porang',
    rawBrand: 'Fitmee',
    rawUnit: '1kg',
    category: null,
    taxoVersion: null,
    storeSlug: 'lotte-mart',
    price: 206100,
    matchConfidence: 1,
  }
  const size = { quantity: 1000, unit: 'g', packCount: 1 }

  it('accepts a size on a v2 item and keeps it in the parsed output', () => {
    const result = safeParse(ingestItemV2Schema, { ...v2Item, size })
    expect(result.success).toBe(true)
    expect(result.success && result.output.size).toEqual(size)
    expect(safeParse(ingestSizeSchema, size).success).toBe(true)
  })

  it('accepts a size without packCount (the backend defaults it to 1)', () => {
    expect(
      safeParse(ingestItemV2Schema, { ...v2Item, size: { quantity: 280, unit: 'g' } }).success
    ).toBe(true)
    expect(safeParse(ingestSizeSchema, { quantity: 280, unit: 'g', packCount: null }).success).toBe(
      true
    )
  })

  it('accepts null and absent sizes so old payloads keep validating', () => {
    expect(safeParse(ingestItemV2Schema, { ...v2Item, size: null }).success).toBe(true)
    expect(safeParse(ingestItemV2Schema, v2Item).success).toBe(true)
  })

  it('carries the size in the shared valid fixture', () => {
    const parsed = safeParse(ingestPayloadV2Schema, validIngest)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.output.items[0]?.size).toEqual({
      quantity: 2000,
      unit: 'ml',
      packCount: 1,
    })
  })

  it('rejects a size without a unit', () => {
    expect(safeParse(ingestItemV2Schema, { ...v2Item, size: { quantity: 280 } }).success).toBe(
      false
    )
  })

  it('rejects a non-positive quantity', () => {
    for (const quantity of [0, -280]) {
      expect(
        safeParse(ingestItemV2Schema, { ...v2Item, size: { quantity, unit: 'g' } }).success
      ).toBe(false)
    }
  })

  it('rejects a packCount below 1 or fractional', () => {
    for (const packCount of [0, -1, 1.5]) {
      expect(
        safeParse(ingestItemV2Schema, { ...v2Item, size: { ...size, packCount } }).success
      ).toBe(false)
    }
  })

  it('rejects an unknown base unit and an unknown size field (strictObject)', () => {
    expect(
      safeParse(ingestItemV2Schema, { ...v2Item, size: { quantity: 1, unit: 'kg' } }).success
    ).toBe(false)
    expect(
      safeParse(ingestItemV2Schema, {
        ...v2Item,
        // totalQuantity/packaging are product-level fields ingest derives or
        // leaves null; a producer may not invent them.
        size: { ...size, totalQuantity: 1000 },
      }).success
    ).toBe(false)
  })
})
