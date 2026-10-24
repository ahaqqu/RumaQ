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
