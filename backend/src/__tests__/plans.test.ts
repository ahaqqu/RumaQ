import { describe, it, expect, vi } from 'vite-plus/test'
import { buildPlanPrompt, generateAiPlan, normalizeItemName } from '../lib/plans.js'

describe('normalizeItemName', () => {
  it('trims and lowercases with single spaces', () => {
    expect(normalizeItemName('  Susu Cair  ')).toBe('susu cair')
    expect(normalizeItemName('TELUR   10pcs')).toBe('telur 10pcs')
  })
})

describe('buildPlanPrompt', () => {
  it('includes stores, low stock, expiring and recent purchases', () => {
    const prompt = buildPlanPrompt(
      [{ name: 'Milk', qty: 0.5, unit: 'L', run_out_days: 2, expiry_date: null }],
      [{ name: 'Bread', qty: 1, unit: 'pack', expiry_date: '2026-07-27' }],
      [{ name: 'Eggs', store_label: 'Pasar' }],
      [{ label: 'Indomaret' }, { label: 'Alfamart' }],
      'IDR'
    )
    expect(prompt).toContain('Indomaret')
    expect(prompt).toContain('Milk')
    expect(prompt).toContain('Bread')
    expect(prompt).toContain('Eggs')
    expect(prompt).toContain('IDR')
  })
})

describe('generateAiPlan', () => {
  it('parses OpenAI response and limits items', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: Array.from({ length: 60 }, (_, i) => ({
                  name: `Item ${i}`,
                  qty: 1,
                  unit: 'pcs',
                  store_id: null,
                  price_estimate: 1000,
                  why: 'low',
                })),
              }),
            },
          },
        ],
      }),
    })
    const items = await generateAiPlan(
      'openai',
      'sk-test',
      [],
      [],
      [],
      [{ id: 's1', label: 'X' }],
      'IDR'
    )
    expect(items.length).toBe(50)
  })

  it('returns empty items on invalid JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json' } }] }),
    })
    const items = await generateAiPlan('openai', 'sk-test', [], [], [], [], 'IDR')
    expect(items).toEqual([])
  })
})
