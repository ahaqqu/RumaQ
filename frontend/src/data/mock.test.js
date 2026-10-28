import { describe, it, expect } from 'vite-plus/test'
import {
  STORES,
  STOCK,
  PLAN,
  HISTORY,
  PARSED_RECEIPT,
  formatRp,
  storeLabel,
  relUpdated,
} from './mock.js'
import { i18n } from '../i18n/index.js'

describe('static data', () => {
  it('exports STORES array', () => {
    expect(Array.isArray(STORES)).toBe(true)
  })
  it('exports STOCK array', () => {
    expect(Array.isArray(STOCK)).toBe(true)
  })
  it('exports PLAN array', () => {
    expect(Array.isArray(PLAN)).toBe(true)
  })
  it('exports HISTORY array', () => {
    expect(Array.isArray(HISTORY)).toBe(true)
  })
  it('exports PARSED_RECEIPT', () => {
    expect(PARSED_RECEIPT.store).toBe('indomaret')
  })
})

describe('formatRp', () => {
  it('formats number as IDR currency', () => {
    const result = formatRp(18500)
    expect(result).toContain('IDR')
    expect(result).toContain('18')
    expect(result).toContain('500')
  })

  it('handles zero', () => {
    expect(formatRp(0)).toContain('0')
  })

  it('formats with id-ID locale', () => {
    const origLang = i18n.language
    i18n.language = 'id'
    const result = formatRp(18500)
    expect(result).toBeTruthy()
    i18n.language = origLang
  })
})

describe('storeLabel', () => {
  it('returns label for known store', () => {
    const label = storeLabel('indomaret')
    expect(typeof label).toBe('string')
    expect(label.length).toBeGreaterThan(0)
  })

  it('returns id for unknown store', () => {
    expect(storeLabel('unknown')).toBe('unknown')
  })
})

describe('relUpdated', () => {
  it('returns "today" for today', () => {
    expect(relUpdated('2026-06-29')).toBe('today')
  })

  it('returns translated today with t function', () => {
    const t = (key) => key
    expect(relUpdated('2026-06-29', t)).toBe('common.today')
    expect(relUpdated('2026-06-28', t)).toBe('common.yesterday')
  })

  it('returns "yesterday" for yesterday', () => {
    expect(relUpdated('2026-06-28')).toBe('yesterday')
  })

  it('returns days ago', () => {
    expect(relUpdated('2026-06-20')).toBe('9 days ago')
  })
})
