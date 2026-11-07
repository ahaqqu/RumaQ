import { describe, it, expect } from 'vite-plus/test'
import { buildScanPrompt, parseScanResult } from '../lib/receipt-scan.js'

// The receipt scan's feature half (ahaqqu/RumaQ#523 P4): the prompt and the
// strict answer parser. The transport is the AI door's `vision()` on the
// household's VISION capability — the scan-to-vision fix is asserted where the
// request is made (`ai-call-sites.test.ts`), not here.

describe('buildScanPrompt', () => {
  it('is a static OCR prompt with no household data in it', () => {
    const prompt = buildScanPrompt()
    expect(prompt).toContain('receipt OCR assistant')
    expect(prompt).toContain('"items"')
    // "store_name" is part of the static receipt schema, not household data.
    expect(prompt).not.toContain('household')
    expect(prompt).not.toContain('Indomaret')
  })
})

describe('parseScanResult (strict post-model gate)', () => {
  it('parses a receipt answer and normalizes each line', () => {
    const result = parseScanResult(
      JSON.stringify({
        store_name: 'Indomaret',
        date: '2026-07-26',
        items: [
          { name: 'Milk', qty: 1, unit: 'L', price: 18500, total: 18500 },
          // Missing qty/unit fall back to the editor defaults; prices round.
          { name: 'Bread', price: 15000.4 },
        ],
      })
    )
    expect(result.store_name).toBe('Indomaret')
    expect(result.date).toBe('2026-07-26')
    expect(result.items).toEqual([
      { name: 'Milk', qty: 1, unit: 'L', price: 18500, total: 18500 },
      { name: 'Bread', qty: 1, unit: 'pcs', price: 15000, total: undefined },
    ])
  })

  it('tolerates a fenced answer (the one extraction policy)', () => {
    const result = parseScanResult(
      '```json\n{"items":[{"name":"Eggs","qty":10,"unit":"pcs","price":32000}]}\n```'
    )
    expect(result.items).toHaveLength(1)
    expect(result.items[0].name).toBe('Eggs')
  })

  it('reads a missing items array as an empty scan, never a crash', () => {
    expect(parseScanResult('{"store_name":"Indomaret"}').items).toEqual([])
    expect(parseScanResult('{"store_name":"Indomaret"}').store_name).toBe('Indomaret')
  })

  it('throws when the answer carries no JSON at all', () => {
    expect(() => parseScanResult('no json here')).toThrow('AI response did not contain valid JSON')
  })
})
