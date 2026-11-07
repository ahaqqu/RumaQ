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
      used: 17,
      input_tokens: 1200,
      output_tokens: 350,
      cached_tokens: 700,
    })
    expect(meter).toMatchObject({
      used: 17,
      inputTokens: 1200,
      outputTokens: 350,
      cacheHitRate: 700 / 1200,
    })
    expect(meter.limit).toBeUndefined()
    expect(meter.warn).toBeUndefined()
    expect(meter.danger).toBeUndefined()
    expect(meter.pct).toBeUndefined()
    // No single provider any more: the capability rows are the attribution.
    expect(meter).not.toHaveProperty('provider')
    expect(meter.capabilities).toEqual([])
    expect(meter.household).toBeNull()
  })

  it('normalizes the per-capability breakdown and the household cut (#523 P4)', () => {
    const meter = usageMeterModel({
      used: 3,
      input_tokens: 1500,
      output_tokens: 180,
      cached_tokens: null,
      capabilities: [
        {
          capability: 'decision',
          used: 1,
          typed_calls: 1,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: null,
        },
        { capability: null, used: 2, typed_calls: 0, input_tokens: 1500, output_tokens: 180 },
      ],
      household: { used: 9, input_tokens: 3000, output_tokens: 900, cached_tokens: 1500 },
    })
    expect(meter.capabilities).toEqual([
      {
        capability: 'decision',
        calls: 1,
        typedCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
      },
      // A pre-gateway row keeps a null capability — "unknown", not a guess.
      { capability: null, calls: 2, typedCalls: 0, inputTokens: 1500, outputTokens: 180 },
    ])
    expect(meter.household).toEqual({ used: 9, inputTokens: 3000, outputTokens: 900 })
    // Unknown (provider reported no cache) stays unknown, never a 0%.
    expect(meter.cacheHitRate).toBeNull()
  })

  it('has no source dimension at all (the shared server key is retired, D8/D9)', () => {
    // #523 P3 dropped `key_source` from the payload and the meter's `ownKey`
    // flag with it: every call is funded by the household's own provider key, so
    // there is nothing to distinguish and nothing to claim.
    const meter = usageMeterModel({
      used: 3,
      input_tokens: 500,
      output_tokens: 100,
      cached_tokens: null,
    })
    expect(meter).not.toHaveProperty('ownKey')
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
