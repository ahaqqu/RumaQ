import { describe, expect, it } from 'vite-plus/test'
import { safeParse } from 'valibot'

import {
  apiErrorSchema,
  canonicalIndexSchema,
  ingestPayloadV2Schema,
  ingestReceiptSchema,
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
