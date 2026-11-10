import { describe, it, expect } from 'vite-plus/test'
import {
  validateImage,
  bytesMatchDeclaredImage,
  extFromType,
  buildKey,
  isOwnReceiptKey,
} from '../lib/receipts.js'

// Leading-byte fixtures for the #606 sniff: each is the type's real file
// signature followed by payload junk, so the tests pin "signature accepted,
// whatever follows" and "wrong/absent signature rejected".
const IMAGE_BYTES = {
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  webp: new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBP'),
  // A real ISO-BMFF ftyp box: 4 size bytes, "ftyp", major brand "mif1".
  heic: new TextEncoder().encode('\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00'),
} as const

// The QA-F1 repro: plain-text bytes renamed reject.png, declared image/png.
const TXT_BYTES = new TextEncoder().encode('this is not an image, just a text file\n')

describe('validateImage', () => {
  it('accepts jpeg under 5MB', () => {
    expect(validateImage({ type: 'image/jpeg', size: 1000, bytes: IMAGE_BYTES.jpeg })).toBeNull()
  })

  it('rejects unsupported type', () => {
    expect(validateImage({ type: 'image/gif', size: 1000, bytes: IMAGE_BYTES.jpeg })).toContain(
      'Unsupported'
    )
  })

  it('rejects oversized file', () => {
    expect(
      validateImage({ type: 'image/jpeg', size: 6 * 1024 * 1024, bytes: IMAGE_BYTES.jpeg })
    ).toContain('too large')
  })
})

// #606: the declared MIME is client-supplied and can lie — the bytes are the
// only trustworthy signal, and every allowed type gets one (the sniff is
// total over ALLOWED_TYPES, HEIC included).
describe('validateImage magic bytes (#606)', () => {
  it('accepts real png, jpeg, webp and heic signatures', () => {
    expect(validateImage({ type: 'image/jpeg', size: 1000, bytes: IMAGE_BYTES.jpeg })).toBeNull()
    expect(validateImage({ type: 'image/png', size: 1000, bytes: IMAGE_BYTES.png })).toBeNull()
    expect(validateImage({ type: 'image/webp', size: 1000, bytes: IMAGE_BYTES.webp })).toBeNull()
    expect(validateImage({ type: 'image/heic', size: 1000, bytes: IMAGE_BYTES.heic })).toBeNull()
  })

  it('rejects text bytes declared as png (the QA-F1 repro) with a friendly message', () => {
    const error = validateImage({ type: 'image/png', size: TXT_BYTES.length, bytes: TXT_BYTES })
    expect(error).toContain('does not look like a valid image')
  })

  it('rejects a real signature declared as the wrong type', () => {
    expect(validateImage({ type: 'image/png', size: 1000, bytes: IMAGE_BYTES.jpeg })).toContain(
      'does not look like a valid image'
    )
  })

  it('rejects bytes too short to carry a signature', () => {
    expect(validateImage({ type: 'image/jpeg', size: 1, bytes: new Uint8Array([0x78]) })).toContain(
      'does not look like a valid image'
    )
  })

  it('accepts an ArrayBuffer carrying the signature', () => {
    expect(
      validateImage({ type: 'image/png', size: 1000, bytes: IMAGE_BYTES.png.buffer as ArrayBuffer })
    ).toBeNull()
  })

  it('bytesMatchDeclaredImage answers per type with no other checks involved', () => {
    expect(bytesMatchDeclaredImage('image/png', IMAGE_BYTES.png)).toBe(true)
    expect(bytesMatchDeclaredImage('image/jpeg', IMAGE_BYTES.jpeg)).toBe(true)
    expect(bytesMatchDeclaredImage('image/webp', IMAGE_BYTES.webp)).toBe(true)
    expect(bytesMatchDeclaredImage('image/heic', IMAGE_BYTES.heic)).toBe(true)
    expect(bytesMatchDeclaredImage('image/png', TXT_BYTES)).toBe(false)
    expect(bytesMatchDeclaredImage('image/gif', IMAGE_BYTES.png)).toBe(false)
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
