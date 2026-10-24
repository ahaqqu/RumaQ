import { describe, it, expect, vi } from 'vite-plus/test'
import { computePatterns } from '../lib/patterns.js'

type Row = {
  item_id: string
  item_name: string | null
  qty: number
  date: string
}

function mockDb(results: Row[], bindMock = vi.fn().mockReturnThis()) {
  return {
    db: {
      prepare: vi.fn().mockReturnThis(),
      bind: bindMock,
      all: vi.fn().mockResolvedValue({ results }),
    } as unknown as D1Database,
    bindMock,
  }
}

describe('computePatterns', () => {
  it('returns empty array when no purchases', async () => {
    const { db } = mockDb([])
    const result = await computePatterns('h1', db)
    expect(result).toEqual([])
  })

  it('returns "recently purchased" pattern for single-purchase items', async () => {
    const rows: Row[] = [{ item_id: 'i1', item_name: 'Milk', qty: 1, date: '2026-07-01' }]
    const { db } = mockDb(rows)
    const result = await computePatterns('h1', db)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      item_id: 'i1',
      name: 'Milk',
      avg_interval_days: null,
      avg_qty: 1,
      pattern: 'recently purchased',
      purchase_count: 1,
    })
  })

  it('computes average interval, avg qty, and "every N days" pattern', async () => {
    const rows: Row[] = [
      { item_id: 'i1', item_name: 'Milk', qty: 1, date: '2026-06-21' },
      { item_id: 'i1', item_name: 'Milk', qty: 1, date: '2026-06-26' },
      { item_id: 'i1', item_name: 'Milk', qty: 1, date: '2026-07-01' },
    ]
    const { db } = mockDb(rows)
    const result = await computePatterns('h1', db)
    expect(result).toHaveLength(1)
    const p = result[0]
    expect(p.avg_interval_days).toBe(5)
    expect(p.avg_qty).toBe(1)
    expect(p.pattern).toBe('every 5 days')
    expect(p.last_purchase_date).toBe('2026-07-01')
    expect(p.purchase_count).toBe(3)
  })

  it('sorts items by purchase count descending and caps at 20', async () => {
    const rows: Row[] = []
    for (let i = 0; i < 25; i++) {
      for (let j = 0; j <= i; j++) {
        rows.push({
          item_id: `i${i}`,
          item_name: `Item${i}`,
          qty: 1,
          date: `2026-07-${String((j % 20) + 1).padStart(2, '0')}`,
        })
      }
    }
    const { db } = mockDb(rows)
    const result = await computePatterns('h1', db)
    expect(result).toHaveLength(20)
    expect(result[0].purchase_count).toBeGreaterThanOrEqual(
      result[result.length - 1].purchase_count
    )
  })

  it('uses "Unknown" name when item_name is null', async () => {
    const rows: Row[] = [{ item_id: 'i1', item_name: null, qty: 2, date: '2026-07-01' }]
    const { db } = mockDb(rows)
    const result = await computePatterns('h1', db)
    expect(result[0].name).toBe('Unknown')
  })

  it('binds the household id when computing patterns', async () => {
    const rows: Row[] = [{ item_id: 'i1', item_name: 'Milk', qty: 1, date: '2026-07-01' }]
    const { db, bindMock } = mockDb(rows)
    const result = await computePatterns('h1', db)
    expect(result).toHaveLength(1)
    expect(bindMock).toHaveBeenCalledWith('h1')
  })
})
