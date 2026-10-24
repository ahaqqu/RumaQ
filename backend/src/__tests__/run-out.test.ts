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

describe('computeRunOutDays', () => {
  it('returns default 30 when no purchase history', async () => {
    const db = mockDb(null)
    const result = await computeRunOutDays('h1', 'i1', 5, db)
    expect(result.run_out_days).toBe(30)
    expect(result.basis).toBe('default')
  })

  it('returns default 30 when fewer than 2 purchases', async () => {
    const db = mockDb([{ qty: 2, date: '2026-07-01' }])
    const result = await computeRunOutDays('h1', 'i1', 5, db)
    expect(result.run_out_days).toBe(30)
    expect(result.basis).toBe('default')
  })

  it('returns 0 when current qty is 0', async () => {
    const db = mockDb([{ qty: 2, date: '2026-07-01' }])
    const result = await computeRunOutDays('h1', 'i1', 0, db)
    expect(result.run_out_days).toBe(0)
    expect(result.basis).toBe('default')
  })

  it('returns 0 when current qty is negative', async () => {
    const db = mockDb([{ qty: 2, date: '2026-07-01' }])
    const result = await computeRunOutDays('h1', 'i1', -1, db)
    expect(result.run_out_days).toBe(0)
    expect(result.basis).toBe('default')
  })

  it('computes run-out days from 2 purchases 30 days apart (weighted)', async () => {
    const purchases = [
      { qty: 2, date: '2026-06-21' },
      { qty: 1, date: '2026-07-21' },
    ]
    const db = mockDb(purchases)
    const result = await computeRunOutDays('h1', 'i1', 1, db)
    expect(result.basis).toBe('history')
    expect(result.run_out_days).toBe(23)
  })

  it('computes correctly with 3+ purchases (weighted)', async () => {
    const purchases = [
      { qty: 3, date: '2026-05-21' },
      { qty: 2, date: '2026-06-21' },
      { qty: 1, date: '2026-07-21' },
    ]
    const db = mockDb(purchases)
    const result = await computeRunOutDays('h1', 'i1', 3, db)
    expect(result.basis).toBe('history')
    expect(result.run_out_days).toBe(110)
  })

  it('isolates items by household and item id', async () => {
    const db = mockDb(null)
    const r1 = await computeRunOutDays('h1', 'i1', 5, db)
    expect(r1.run_out_days).toBe(30)

    const r2 = await computeRunOutDays('h2', 'i2', 10, db)
    expect(r2.run_out_days).toBe(30)
  })

  it('returns default when all purchases have zero qty', async () => {
    const purchases = [
      { qty: 0, date: '2026-06-21' },
      { qty: 0, date: '2026-07-21' },
    ]
    const db = mockDb(purchases)
    const result = await computeRunOutDays('h1', 'i1', 5, db)
    expect(result.run_out_days).toBe(30)
    expect(result.basis).toBe('default')
  })

  it('returns default when purchases are on the same day', async () => {
    const purchases = [
      { qty: 2, date: '2026-07-21' },
      { qty: 3, date: '2026-07-21' },
    ]
    const db = mockDb(purchases)
    const result = await computeRunOutDays('h1', 'i1', 5, db)
    expect(result.run_out_days).toBe(30)
    expect(result.basis).toBe('default')
  })
})
