import { describe, it, expect } from 'vite-plus/test'
import { formatTokens, usageState, usageMeterModel } from './usage.js'

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

describe('usageState', () => {
  it('returns correct pct and flags for normal usage', () => {
    const state = usageState({ used: 5, limit: 20 })
    expect(state.pct).toBe(25)
    expect(state.remaining).toBe(15)
    expect(state.warn).toBe(false)
    expect(state.danger).toBe(false)
  })

  it('returns warn flag when near limit', () => {
    const state = usageState({ used: 17, limit: 20 })
    expect(state.warn).toBe(true)
    expect(state.danger).toBe(false)
  })

  it('returns danger flag at limit', () => {
    const state = usageState({ used: 20, limit: 20 })
    expect(state.danger).toBe(true)
    expect(state.warn).toBe(false)
    expect(state.remaining).toBe(0)
  })

  it('caps pct at 100', () => {
    const state = usageState({ used: 25, limit: 20 })
    expect(state.pct).toBe(100)
  })
})

describe('usageMeterModel', () => {
  it('returns null without loaded data', () => {
    expect(usageMeterModel(undefined)).toBeNull()
  })

  it('meters server-key usage against the daily cap', () => {
    const meter = usageMeterModel({ provider: 'Gemini', used: 17, daily_limit: 20 })
    expect(meter.ownKey).toBe(false)
    expect(meter.limit).toBe(20)
    expect(meter.warn).toBe(true)
    expect(meter.danger).toBe(false)
    expect(meter.pct).toBe(85)
  })

  it('marks own-key usage and keeps token counts', () => {
    const meter = usageMeterModel({
      provider: 'Ollama Cloud',
      used: 3,
      daily_limit: 20,
      input_tokens: 18230,
      output_tokens: 6100,
      key_source: 'user',
    })
    expect(meter.ownKey).toBe(true)
    expect(meter.inputTokens).toBe(18230)
    expect(meter.outputTokens).toBe(6100)
  })
})
