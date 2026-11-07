import { describe, it, expect } from 'vite-plus/test'
import { buildPlanPrompt } from '../lib/plans.js'
import { buildChatSystemPrompt } from '../lib/chat.js'
import { buildScanPrompt } from '../lib/receipt-scan.js'

// Reaching into the private function through module internals would require
// exporting it. Instead we test the public prompt builders that are used by
// the API. The scan prompt is static and contains no household data.

describe('buildPlanPrompt prompt isolation', () => {
  const householdAStores = [{ label: 'Indomaret' }, { label: 'Alfamart' }]
  const householdBStores = [{ label: 'Superindo' }, { label: 'Lottemart' }]

  const householdALowStock = [
    { name: 'Milk', qty: 1, unit: 'L', run_out_days: 2, expiry_date: null },
  ]
  const householdBLowStock = [
    { name: 'Rice', qty: 2, unit: 'kg', run_out_days: 5, expiry_date: null },
  ]

  it('only contains the requested household store labels', () => {
    const prompt = buildPlanPrompt(householdALowStock, [], [], householdAStores, 'IDR')
    expect(prompt).toContain('Indomaret')
    expect(prompt).toContain('Alfamart')
    expect(prompt).not.toContain('Superindo')
    expect(prompt).not.toContain('Lottemart')
  })

  it('only contains the requested household item names', () => {
    const promptA = buildPlanPrompt(householdALowStock, [], [], householdAStores, 'IDR')
    const promptB = buildPlanPrompt(householdBLowStock, [], [], householdBStores, 'IDR')

    expect(promptA).toContain('Milk')
    expect(promptA).not.toContain('Rice')

    expect(promptB).toContain('Rice')
    expect(promptB).not.toContain('Milk')
  })

  it('does not leak internal DB identifiers', () => {
    const stores = [{ label: 'Indomaret' }]
    const prompt = buildPlanPrompt([], [], [], stores, 'IDR')
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(prompt).not.toContain('store-')
    expect(prompt).not.toContain('uuid:')
  })
})

describe('buildChatSystemPrompt prompt isolation', () => {
  it('only contains the provided household context', () => {
    const ctx = {
      persona: null,
      lowStock: [{ name: 'Milk', qty: 1, unit: 'L', run_out_days: 2 }],
      expiring: [{ name: 'Yogurt', qty: 2, unit: 'cup', expiry_date: '2026-07-30' }],
      activePlan: [{ name: 'Bread', qty: 1, unit: 'pack', store_label: 'Indomaret' }],
      recentPurchases: [{ name: 'Eggs', store_label: 'Alfamart' }],
    }

    const prompt = buildChatSystemPrompt(ctx)

    expect(prompt).toContain('Milk')
    expect(prompt).toContain('Yogurt')
    expect(prompt).toContain('Bread')
    expect(prompt).toContain('Eggs')
    expect(prompt).not.toContain('Rice')
    expect(prompt).not.toContain('Lottemart')
  })
})

describe('buildScanPrompt', () => {
  it('contains no household data at all', () => {
    // The scan prompt is static product policy (lib/receipt-scan.ts): it carries
    // no household data, so nothing from one household can reach another's read.
    const prompt = buildScanPrompt()
    expect(prompt).toContain('receipt OCR assistant')
    expect(prompt).not.toContain('household')
    // "store_name" is part of the static receipt schema, not household data.
    expect(prompt).not.toContain('Indomaret')
    expect(prompt).not.toContain('Superindo')
  })
})
