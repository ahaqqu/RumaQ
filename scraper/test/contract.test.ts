// Contract schema check for the run report's per-store rejectedItems field
// (issue #362) — the producer-side no-drift proof, riding the same strict
// schema the report capture parses in pipeline/stubs.ts. Lives in the scraper
// suite because the scraper is the producer (the backend's own report-schema
// tests stay in backend/src/__tests__/price-runs.test.ts). The issue #367
// audit object and the ingest item's originalPrice ride the same proof below.

import { describe, expect, it } from 'vite-plus/test'
import { parse, safeParse } from 'valibot'

import {
  ingestItemSchema,
  ingestPayloadSchema,
  runAuditSchema,
  runReportSchema,
} from '@rumaq/contract'

function sampleStore() {
  return {
    pagesFound: 2,
    newImages: 1,
    existingImages: 1,
    skipped: 0,
    itemsExtracted: 7,
    itemsRejected: 2,
  }
}

function sampleReport(perStore: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    runStartedAt: '2026-11-01T23:00:05Z',
    finishedAt: '2026-11-01T23:04:11Z',
    exitCode: 0 as const,
    status: 'success' as const,
    stage: 'done' as const,
    perStore,
    match: null,
    publish: null,
    error: null,
  }
}

const sampleReject = {
  source: 'promo-2026-11-01-1.jpg',
  name: 'B',
  reason: 'name_too_short',
}

describe('runReportStoreSchema rejectedItems (issue #362)', () => {
  it('accepts a report carrying per-item reject reasons', () => {
    const report = sampleReport({ superindo: { ...sampleStore(), rejectedItems: [sampleReject] } })
    expect(safeParse(runReportSchema, report).success).toBe(true)
    expect(parse(runReportSchema, report).perStore['superindo']!.rejectedItems).toEqual([
      sampleReject,
    ])
  })

  it('accepts a reject without a name — a raw item with no readable name', () => {
    const report = sampleReport({
      superindo: {
        ...sampleStore(),
        rejectedItems: [{ source: 'promo.jpg', reason: 'price_invalid: 1274900' }],
      },
    })
    expect(safeParse(runReportSchema, report).success).toBe(true)
  })

  it('still accepts an old-scraper report without the field (additive)', () => {
    expect(sampleReport({ superindo: sampleStore() }).perStore['superindo']).not.toHaveProperty(
      'rejectedItems'
    )
    expect(safeParse(runReportSchema, sampleReport({ superindo: sampleStore() })).success).toBe(
      true
    )
  })

  it('rejects over-length or wrong-typed items', () => {
    const withRejects = (rejects: unknown) =>
      sampleReport({ superindo: { ...sampleStore(), rejectedItems: rejects } })
    // The caps: a URL source can be long (300), a reason is short (200).
    expect(
      safeParse(runReportSchema, withRejects([{ ...sampleReject, source: 'x'.repeat(301) }]))
        .success
    ).toBe(false)
    expect(
      safeParse(runReportSchema, withRejects([{ ...sampleReject, name: 'x'.repeat(301) }])).success
    ).toBe(false)
    expect(
      safeParse(runReportSchema, withRejects([{ ...sampleReject, reason: 'x'.repeat(201) }]))
        .success
    ).toBe(false)
    expect(
      safeParse(
        runReportSchema,
        withRejects([
          {
            ...sampleReject,
            source: 'x'.repeat(300),
            name: 'y'.repeat(300),
            reason: 'z'.repeat(200),
          },
        ])
      ).success
    ).toBe(true)
    // Wrong types.
    expect(safeParse(runReportSchema, withRejects([{ ...sampleReject, reason: 42 }])).success).toBe(
      false
    )
    expect(
      safeParse(runReportSchema, withRejects([{ ...sampleReject, source: null }])).success
    ).toBe(false)
    // strictObject: an unknown field is contract drift.
    expect(
      safeParse(runReportSchema, withRejects([{ ...sampleReject, extra: true }])).success
    ).toBe(false)
  })
})

// Issue #367 (phase 1): the additive originalPrice on the ingest item and the
// additive per-store audit object on the run report — the same producer-side
// no-drift proof as the rejectedItems block above.

describe('runReportStoreSchema audit (issue #367)', () => {
  const sampleAudit = {
    sampledPages: 2,
    nameAgreePct: 98,
    priceAgreePct: 100,
    originalAgreePct: 95,
    promoAgreePct: 100,
    disagreements: [
      {
        imageFilename: 'promo-2026-11-01-1.jpg',
        field: 'price',
        primary: '17000',
        shadow: '17500',
      },
    ],
  }

  it('accepts a report carrying the shadow-audit metrics', () => {
    const report = sampleReport({ superindo: { ...sampleStore(), audit: sampleAudit } })
    expect(safeParse(runReportSchema, report).success).toBe(true)
    expect(parse(runReportSchema, report).perStore['superindo']!.audit).toEqual(sampleAudit)
  })

  it('accepts an audit with no disagreements (a fully agreeing sample)', () => {
    const report = sampleReport({
      superindo: { ...sampleStore(), audit: { ...sampleAudit, disagreements: [] } },
    })
    expect(safeParse(runReportSchema, report).success).toBe(true)
  })

  it('still accepts an old-scraper report without the field (additive)', () => {
    expect(sampleReport({ superindo: sampleStore() }).perStore['superindo']).not.toHaveProperty(
      'audit'
    )
    expect(safeParse(runReportSchema, sampleReport({ superindo: sampleStore() })).success).toBe(
      true
    )
  })

  it('rejects out-of-domain percentages, over-cap arrays, and unknown fields', () => {
    const withAudit = (audit: unknown) => sampleReport({ superindo: { ...sampleStore(), audit } })
    // Percentages are 0–100 rounded integers.
    expect(
      safeParse(runReportSchema, withAudit({ ...sampleAudit, priceAgreePct: 101 })).success
    ).toBe(false)
    expect(
      safeParse(runReportSchema, withAudit({ ...sampleAudit, priceAgreePct: 99.5 })).success
    ).toBe(false)
    // maxItems(10) — an over-cap disagreements array must 400 at the ingest,
    // which is why the producer truncates with the same exported limit.
    expect(
      safeParse(
        runReportSchema,
        withAudit({
          ...sampleAudit,
          disagreements: Array.from({ length: 11 }, () => sampleAudit.disagreements[0]),
        })
      ).success
    ).toBe(false)
    // strictObject: an unknown field is contract drift.
    expect(safeParse(runReportSchema, withAudit({ ...sampleAudit, extra: true })).success).toBe(
      false
    )
  })

  it('enforces the disagreement string caps', () => {
    const audit = {
      ...sampleAudit,
      disagreements: [{ ...sampleAudit.disagreements[0], primary: 'x'.repeat(121) }],
    }
    expect(safeParse(runAuditSchema, audit).success).toBe(false)
    expect(
      safeParse(runAuditSchema, {
        ...sampleAudit,
        disagreements: [{ ...sampleAudit.disagreements[0], primary: 'x'.repeat(120) }],
      }).success
    ).toBe(true)
  })
})

describe('ingestItemSchema originalPrice (issue #367)', () => {
  function sampleItem(over: Record<string, unknown>) {
    return safeParse(ingestItemSchema, {
      productKey: 'teh-kotak--null--250-ml',
      name: 'Teh Kotak 250ml',
      storeSlug: 'superindo',
      price: 5000,
      matchConfidence: 1.0,
      ...over,
    })
  }

  it('accepts an item carrying a non-negative integer originalPrice', () => {
    const result = sampleItem({ originalPrice: 6500 })
    expect(result.success).toBe(true)
  })

  it('accepts an explicit null and an absent field (old payloads validate)', () => {
    expect(sampleItem({ originalPrice: null }).success).toBe(true)
    expect(sampleItem({}).success).toBe(true)
  })

  it('rejects negative, fractional, and wrong-typed originalPrice', () => {
    expect(sampleItem({ originalPrice: -1 }).success).toBe(false)
    expect(sampleItem({ originalPrice: 6500.5 }).success).toBe(false)
    expect(sampleItem({ originalPrice: '6500' }).success).toBe(false)
  })

  it('keeps the whole-payload strict shape — old payloads on the new schema pass', () => {
    const result = safeParse(ingestPayloadSchema, {
      schemaVersion: 1,
      scrapedAt: '2026-10-24T23:00:05Z',
      stores: [{ slug: 'superindo', name: 'Superindo', region: 'jakarta' }],
      items: [
        {
          productKey: 'teh-kotak--null--250-ml',
          name: 'Teh Kotak 250ml',
          storeSlug: 'superindo',
          price: 5000,
          originalPrice: 6500,
          matchConfidence: 1.0,
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})
