// Contract schema check for the run report's per-store rejectedItems field
// (issue #362) — the producer-side no-drift proof, riding the same strict
// schema the report capture parses in pipeline/stubs.ts. Lives in the scraper
// suite because the scraper is the producer (the backend's own report-schema
// tests stay in backend/src/__tests__/price-runs.test.ts).

import { describe, expect, it } from 'vite-plus/test'
import { parse, safeParse } from 'valibot'

import { runReportSchema } from '@rumaq/contract'

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
