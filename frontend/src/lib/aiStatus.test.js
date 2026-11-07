import { describe, it, expect } from 'vite-plus/test'
import { isAiConfigured } from './aiStatus.js'

// "Can this feature call AI?" (#523 P4): one answer per capability, the same
// dimension the backend route resolves. The P2 bridge's reasoning → decision →
// vision ladder is gone, so the UI must not borrow another capability's status.

describe('isAiConfigured', () => {
  it('is false without status data (nothing is assumed)', () => {
    expect(isAiConfigured(undefined)).toBe(false)
    expect(isAiConfigured(null)).toBe(false)
    expect(isAiConfigured({})).toBe(false)
  })

  it('asks about the capability the feature actually calls', () => {
    const status = { decision: 'none', reasoning: 'household', vision: 'none' }
    expect(isAiConfigured(status, 'reasoning')).toBe(true)
    expect(isAiConfigured(status, 'decision')).toBe(false)
    expect(isAiConfigured(status, 'vision')).toBe(false)
    // Chat and plans default to reasoning (their route's capability).
    expect(isAiConfigured(status)).toBe(true)
  })

  it('does NOT report configured because a different capability is usable', () => {
    // The P3 review's A3 class of lie, one dimension over: a household that only
    // configured vision cannot chat, and the Assistant must say so.
    expect(isAiConfigured({ decision: 'none', reasoning: 'none', vision: 'household' })).toBe(false)
    expect(isAiConfigured({ decision: 'household', reasoning: 'none', vision: 'none' })).toBe(false)
  })
})
