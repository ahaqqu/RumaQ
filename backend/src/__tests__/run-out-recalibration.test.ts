import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test'
import { computeRunOutDays } from '../lib/stock.js'

function mockDb(results: Array<{ qty: number; date: string }> | null) {
  return {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results }),
  } as unknown as D1Database
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-21T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('computeRunOutDays — recalibration from full history', () => {
  it('uses full history when more than 5 purchases exist', async () => {
    const purchases = Array.from({ length: 8 }, (_, i) => ({
      qty: 1,
      date: new Date(Date.parse('2026-07-21') - (7 - i) * 7 * 86400000).toISOString().slice(0, 10),
    }))
    const db = mockDb(purchases)
    const result = await computeRunOutDays('h1', 'i1', 1, db)
    expect(result.basis).toBe('history')
    expect(result.run_out_days).toBeGreaterThan(0)
  })

  it('falls back to default when no purchase in the last 90 days', async () => {
    const purchases = [
      { qty: 2, date: '2026-01-21' },
      { qty: 1, date: '2026-04-01' },
    ]
    const db = mockDb(purchases)
    const result = await computeRunOutDays('h1', 'i1', 5, db)
    expect(result.run_out_days).toBe(30)
    expect(result.basis).toBe('default')
  })

  it('keeps history basis when latest purchase is within 90 days', async () => {
    const purchases = [
      { qty: 2, date: '2026-05-21' },
      { qty: 1, date: '2026-07-01' },
    ]
    const db = mockDb(purchases)
    const result = await computeRunOutDays('h1', 'i1', 2, db)
    expect(result.basis).toBe('history')
  })

  it('weights recent purchases more heavily than old purchases', async () => {
    const increasingRecent = [
      { qty: 1, date: '2026-05-21' },
      { qty: 2, date: '2026-06-21' },
      { qty: 3, date: '2026-07-21' },
    ]
    const decreasingRecent = [
      { qty: 3, date: '2026-05-21' },
      { qty: 2, date: '2026-06-21' },
      { qty: 1, date: '2026-07-21' },
    ]
    const increasing = await computeRunOutDays('h1', 'i1', 3, mockDb(increasingRecent))
    const decreasing = await computeRunOutDays('h1', 'i1', 3, mockDb(decreasingRecent))
    expect(increasing.run_out_days).toBeLessThan(decreasing.run_out_days ?? 0)
    expect(increasing.basis).toBe('history')
    expect(decreasing.basis).toBe('history')
  })
})
