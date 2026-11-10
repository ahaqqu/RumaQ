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

  it('orders the model to accompany a line-total fallback with the line amount as total (#567-B1)', () => {
    // Since #518 the fallback price feeds the PERMANENT grand total; a
    // fallback left unaccompanied would be multiplied by qty server-side.
    // The prompt must make the fallback self-announcing.
    const prompt = buildScanPrompt()
    expect(prompt).toContain('ALWAYS emit that same line amount as total too')
    expect(prompt).toContain('price is the line-total fallback')
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

  // #567-B1: a line whose qty is not exactly 1 and that has no printed total
  // is exactly the shape where the prompt's line-total fallback (price := the
  // line amount) would be multiplied by qty into the PERSISTED grand total
  // ("TELUR 10 BUTIR 28.000" → 280.000; a fractional qty halves instead of
  // inflating — the same compounding, so the same guard). The lib must flag
  // such rows so the review screen holds submit until the user confirms the
  // unit price — never silently multiplied.
  describe('line-total-fallback guard (#567-B1)', () => {
    it('flags a qty>1 line with no printed total', () => {
      const result = parseScanResult(
        JSON.stringify({ items: [{ name: 'Telur', qty: 10, unit: 'pcs', price: 28000 }] })
      )
      expect(result.items[0].needsPriceReview).toBe(true)
    })

    it('does not flag a line with a printed total — the amount is anchored', () => {
      const result = parseScanResult(
        JSON.stringify({
          items: [{ name: 'Telur', qty: 10, unit: 'pcs', price: 2800, total: 28000 }],
        })
      )
      expect(result.items[0].needsPriceReview).toBeUndefined()
    })

    it('does not flag qty=1 lines — nothing to multiply', () => {
      const result = parseScanResult(
        JSON.stringify({ items: [{ name: 'Bread', qty: 1, unit: 'pack', price: 15000 }] })
      )
      expect(result.items[0].needsPriceReview).toBeUndefined()
    })

    it('flags a fractional qty too — qty 0.5 halves a line-total fallback', () => {
      const result = parseScanResult(
        JSON.stringify({ items: [{ name: 'Beras', qty: 0.5, unit: 'kg', price: 32500 }] })
      )
      expect(result.items[0].needsPriceReview).toBe(true)
    })

    it('treats a non-positive total as no printed total, never as an anchor', () => {
      // 0 / -1 are not printed line amounts (a negative would also fail the
      // POST's integer >= 0 validation); the line must stay flagged.
      for (const total of [0, -1]) {
        const result = parseScanResult(
          JSON.stringify({ items: [{ name: 'Telur', qty: 10, unit: 'pcs', price: 28000, total }] })
        )
        expect(result.items[0].total).toBeUndefined()
        expect(result.items[0].needsPriceReview).toBe(true)
      }
    })

    it('flags every unanchored multi-qty line in a mixed receipt', () => {
      const result = parseScanResult(
        JSON.stringify({
          items: [
            { name: 'Telur', qty: 10, unit: 'pcs', price: 28000 },
            { name: 'Susu', qty: 2, unit: 'L', price: 20000, total: 30000 },
            { name: 'Beras', qty: 5, unit: 'kg', price: 13000 },
          ],
        })
      )
      expect(result.items.map((it) => it.needsPriceReview === true)).toEqual([true, false, true])
    })
  })
})
