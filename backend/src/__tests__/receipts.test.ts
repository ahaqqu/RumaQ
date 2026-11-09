import { describe, it, expect } from 'vite-plus/test'
import { validateImage, extFromType, buildKey, isOwnReceiptKey } from '../lib/receipts.js'

describe('validateImage', () => {
  it('accepts jpeg under 5MB', () => {
    expect(validateImage({ type: 'image/jpeg', size: 1000 })).toBeNull()
  })

  it('rejects unsupported type', () => {
    expect(validateImage({ type: 'image/gif', size: 1000 })).toContain('Unsupported')
  })

  it('rejects oversized file', () => {
    expect(validateImage({ type: 'image/jpeg', size: 6 * 1024 * 1024 })).toContain('too large')
  })
})

describe('extFromType', () => {
  it('returns mapped extension', () => {
    expect(extFromType('image/png')).toBe('png')
  })

  it('defaults to jpg for unknown type', () => {
    expect(extFromType('image/webp')).toBe('webp')
    expect(extFromType('application/pdf')).toBe('jpg')
  })
})

describe('buildKey', () => {
  it('generates a key with household and extension', () => {
    const key = buildKey('h1', 'u1', 'jpg')
    expect(key).toContain('receipts/h1/')
    expect(key).toContain('.jpg')
  })
})

// #525 drift pin: the validator must accept exactly what the builder emits.
// If buildKey's layout ever changes without isOwnReceiptKey following (or the
// extension map grows/shrinks), these fail CI instead of stranding legit
// uploads on the write path.
describe('isOwnReceiptKey vs buildKey', () => {
  it('accepts buildKey output for its own household across every producible extension', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']) {
      const key = buildKey('h1', 'u1', extFromType(type))
      expect(isOwnReceiptKey(key, 'h1')).toBe(true)
    }
  })

  it('rejects buildKey output read against a different household', () => {
    const key = buildKey('h2', 'u2', 'jpg')
    expect(isOwnReceiptKey(key, 'h1')).toBe(false)
  })
})
