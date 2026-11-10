import { describe, it, expect } from 'vite-plus/test'
import { planItemPatchSchema, planCreateSchema, planGenerateResponseSchema } from '../lib/plans.js'
import { safeParse } from 'valibot'

describe('planItemPatchSchema', () => {
  it('accepts bought status', () => {
    const result = safeParse(planItemPatchSchema, { status: 'bought' })
    expect(result.success).toBe(true)
  })

  it('accepts skipped status', () => {
    const result = safeParse(planItemPatchSchema, { status: 'skipped' })
    expect(result.success).toBe(true)
  })

  it('rejects invalid status', () => {
    const result = safeParse(planItemPatchSchema, { status: 'pending' })
    expect(result.success).toBe(false)
  })

  it('rejects empty body', () => {
    const result = safeParse(planItemPatchSchema, {})
    expect(result.success).toBe(false)
  })

  it('rejects unknown fields', () => {
    const result = safeParse(planItemPatchSchema, {
      status: 'bought',
      extra: 'field',
    })
    expect(result.success).toBe(false)
  })
})

describe('planCreateSchema', () => {
  it('accepts valid plan items', () => {
    const result = safeParse(planCreateSchema, {
      items: [
        {
          name: 'Susu',
          qty: 1,
          unit: 'L',
          store_id: 's1',
          price_estimate: 15000,
          why: 'Habis',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts minimal items without optional fields', () => {
    const result = safeParse(planCreateSchema, {
      items: [{ name: 'Susu', qty: 1, unit: 'L' }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects items with empty name', () => {
    const result = safeParse(planCreateSchema, {
      items: [{ name: '', qty: 1, unit: 'L' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects items with negative qty', () => {
    const result = safeParse(planCreateSchema, {
      items: [{ name: 'Susu', qty: -1, unit: 'L' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects an absurd qty (#586)', () => {
    // The cap mirrors the purchase line's qty: the value is multiplied into
    // plans.total_estimate, so the wire shape is bounded.
    const result = safeParse(planCreateSchema, {
      items: [{ name: 'Susu', qty: 1_000_001, unit: 'L' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects an absurd price_estimate (#586)', () => {
    const result = safeParse(planCreateSchema, {
      items: [{ name: 'Susu', qty: 1, unit: 'L', price_estimate: 1_000_000_000_001 }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a negative price_estimate (R587-A2)', () => {
    // Purchase-side money fields both carry minValue(0); the estimate feeds
    // Σ estimate × qty, so a negative one would SUBTRACT from the total.
    const result = safeParse(planCreateSchema, {
      items: [{ name: 'Susu', qty: 1, unit: 'L', price_estimate: -500 }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a line whose check-off amount (estimate × qty) exceeds the money bound (R587-A1)', () => {
    // Both fields inside their per-field caps, but the check-off INSERT
    // persists estimate × qty as the line amount — 1e15 against the 1e12
    // bound the purchase line's computed fallback obeys.
    const result = safeParse(planCreateSchema, {
      items: [{ name: 'Susu', qty: 1_000_000, unit: 'L', price_estimate: 1_000_000_000 }],
    })
    expect(result.success).toBe(false)
  })

  it('accepts estimate × qty exactly at the money bound (R587-A1 boundary)', () => {
    const result = safeParse(planCreateSchema, {
      items: [{ name: 'Susu', qty: 1_000_000, unit: 'L', price_estimate: 1_000_000 }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty items array', () => {
    const result = safeParse(planCreateSchema, { items: [] })
    expect(result.success).toBe(false)
  })
})

describe('planGenerateResponseSchema', () => {
  it('accepts valid AI response', () => {
    const result = safeParse(planGenerateResponseSchema, {
      items: [
        {
          name: 'Susu',
          qty: 1,
          unit: 'L',
          store_id: null,
          price_estimate: 15000,
          why: 'Habis',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts items without optional store_id and price_estimate', () => {
    const result = safeParse(planGenerateResponseSchema, {
      items: [{ name: 'Susu', qty: 1, unit: 'L', why: 'Habis' }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects items without name', () => {
    const result = safeParse(planGenerateResponseSchema, {
      items: [{ qty: 1, unit: 'L', why: 'test' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects items with empty name', () => {
    const result = safeParse(planGenerateResponseSchema, {
      items: [{ name: '', qty: 1, unit: 'L', why: 'test' }],
    })
    expect(result.success).toBe(false)
  })
})
