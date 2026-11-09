import { describe, it, expect } from 'vite-plus/test'
import { buildPlanPrompt, normalizeItemName } from '../lib/plans.js'

describe('buildPlanPrompt', () => {
  const lowStock = [
    {
      name: 'Susu cair',
      qty: 0.5,
      unit: 'L',
      run_out_days: 2,
      expiry_date: null,
    },
    { name: 'Telur', qty: 3, unit: 'pcs', run_out_days: 3, expiry_date: null },
  ]
  const expiring = [{ name: 'Roti tawar', qty: 0.5, unit: 'pack', expiry_date: '2026-07-01' }]
  const recentPurchases = [
    { name: 'Susu cair', store_label: 'Indomaret' },
    { name: 'Roti tawar', store_label: 'Indomaret' },
  ]
  const stores = [
    { id: 'store-1', label: 'Indomaret' },
    { id: 'store-2', label: 'Pasar' },
  ]

  it('includes store id+label pairs in prompt (#519)', () => {
    const prompt = buildPlanPrompt(lowStock, expiring, recentPurchases, stores, 'IDR')
    expect(prompt).toContain('Indomaret')
    expect(prompt).toContain('Pasar')
    // The model is asked for a store_id, so the ids must be ON the list —
    // labels alone made it invent one and POST /api/plans 400 on it.
    expect(prompt).toContain('store-1')
    expect(prompt).toContain('store-2')
    expect(prompt).toContain('exactly one of the listed ids')
  })

  it('includes low-stock items', () => {
    const prompt = buildPlanPrompt(lowStock, expiring, recentPurchases, stores, 'IDR')
    expect(prompt).toContain('Susu cair')
    expect(prompt).toContain('Telur')
    expect(prompt).toContain('runs out in 2 days')
  })

  it('includes expiring items', () => {
    const prompt = buildPlanPrompt(lowStock, expiring, recentPurchases, stores, 'IDR')
    expect(prompt).toContain('Roti tawar')
    expect(prompt).toContain('expires: 2026-07-01')
  })

  it('includes recent purchase history', () => {
    const prompt = buildPlanPrompt(lowStock, expiring, recentPurchases, stores, 'IDR')
    expect(prompt).toContain('Susu cair @ Indomaret')
  })

  it('handles empty stores', () => {
    const prompt = buildPlanPrompt(lowStock, expiring, recentPurchases, [], 'IDR')
    expect(prompt).toContain('No stores configured')
  })

  it('handles empty low stock', () => {
    const prompt = buildPlanPrompt([], expiring, recentPurchases, stores, 'IDR')
    expect(prompt).toContain('None')
  })

  it('uses the provided currency', () => {
    const prompt = buildPlanPrompt(lowStock, expiring, recentPurchases, stores, 'USD')
    expect(prompt).toContain('USD')
  })

  it('requests JSON format output', () => {
    const prompt = buildPlanPrompt(lowStock, expiring, recentPurchases, stores, 'IDR')
    expect(prompt).toContain('"items"')
    expect(prompt).toContain('"store_id"')
  })
})

describe('normalizeItemName', () => {
  it('trims whitespace', () => {
    expect(normalizeItemName('  Susu  ')).toBe('susu')
  })

  it('lowercases', () => {
    expect(normalizeItemName('SUSU CAIR')).toBe('susu cair')
  })

  it('collapses multiple spaces', () => {
    expect(normalizeItemName('Susu   Cair  1L')).toBe('susu cair 1l')
  })
})
