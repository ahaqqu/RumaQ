import { describe, it, expect } from 'vite-plus/test'
import { formatTokens, formatCacheRate, usageMeterModel } from './usage.js'

describe('formatTokens', () => {
  it('formats compact token counts', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(18230)).toBe('18.2k')
    expect(formatTokens(234500)).toBe('235k')
    expect(formatTokens(undefined)).toBe('0')
  })
})

describe('formatCacheRate', () => {
  it('formats a ratio as a percentage', () => {
    expect(formatCacheRate(0.42)).toBe('42%')
    expect(formatCacheRate(0)).toBe('0%')
    expect(formatCacheRate(1)).toBe('100%')
  })

  it('returns null for unknown rate so callers render "—", not 0%', () => {
    expect(formatCacheRate(null)).toBeNull()
    expect(formatCacheRate(undefined)).toBeNull()
  })
})

describe('usageMeterModel', () => {
  it('returns null without loaded data', () => {
    expect(usageMeterModel(undefined)).toBeNull()
    expect(usageMeterModel(null)).toBeNull()
  })

  it('exposes calls and token counts with no limit, percent, warn or danger (#353)', () => {
    const meter = usageMeterModel({
      provider: 'Gemini',
      used: 17,
      input_tokens: 1200,
      output_tokens: 350,
      cached_tokens: 700,
      key_source: 'user',
    })
    expect(meter).toEqual({
      ownKey: true,
      used: 17,
      inputTokens: 1200,
      outputTokens: 350,
      cacheHitRate: 700 / 1200,
    })
    expect(meter.limit).toBeUndefined()
    expect(meter.warn).toBeUndefined()
    expect(meter.danger).toBeUndefined()
    expect(meter.pct).toBeUndefined()
  })

  it('treats server-key usage the same: recorded, uncapped', () => {
    const meter = usageMeterModel({
      used: 3,
      input_tokens: 500,
      output_tokens: 100,
      cached_tokens: null,
      key_source: 'server',
    })
    expect(meter.ownKey).toBe(false)
    expect(meter.used).toBe(3)
    expect(meter.cacheHitRate).toBeNull()
  })

  it('renders cache hit rate only when the provider reported cache data and input exists', () => {
    expect(
      usageMeterModel({ used: 1, input_tokens: 0, output_tokens: 0, cached_tokens: 0 }).cacheHitRate
    ).toBeNull()
    expect(
      usageMeterModel({ used: 1, input_tokens: 100, output_tokens: 0, cached_tokens: null })
        .cacheHitRate
    ).toBeNull()
    expect(
      usageMeterModel({ used: 1, input_tokens: 100, output_tokens: 0, cached_tokens: 0 })
        .cacheHitRate
    ).toBe(0)
  })
})
