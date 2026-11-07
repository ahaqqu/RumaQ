import { describe, it, expect } from 'vite-plus/test'
import { encryptAiKey, decryptAiKey, base64UrlEncode, base64UrlDecode } from '../lib/crypto.js'

const TEST_KEY = 'abcdefghijklmnopqrstuvwxyz123456'
const SHORT_KEY = 'short'
const LONG_HEX_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
const LONG_ASCII_KEY = 'a'.repeat(64)

describe('base64UrlEncode / base64UrlDecode', () => {
  it('round-trips a buffer', () => {
    const input = new TextEncoder().encode('hello world')
    const encoded = base64UrlEncode(input)
    const decoded = base64UrlDecode(encoded)
    expect(new TextDecoder().decode(decoded)).toBe('hello world')
  })

  it('encodes without padding or +/', () => {
    const input = new TextEncoder().encode('test')
    const encoded = base64UrlEncode(input)
    expect(encoded).not.toContain('=')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
  })
})

describe('encryptAiKey / decryptAiKey', () => {
  it('round-trips a plain text key', async () => {
    const plain = 'sk-my-secret-api-key-12345'
    const encrypted = await encryptAiKey(plain, TEST_KEY)
    expect(encrypted).toMatch(/^v1:/)
    const decrypted = await decryptAiKey(encrypted, TEST_KEY)
    expect(decrypted).toBe(plain)
  })

  it('produces different ciphertexts each time (random IV)', async () => {
    const plain = 'same-key-every-time'
    const a = await encryptAiKey(plain, TEST_KEY)
    const b = await encryptAiKey(plain, TEST_KEY)
    expect(a).not.toBe(b)
  })

  it('throws on wrong decryption key', async () => {
    const plain = 'secret-value'
    const encrypted = await encryptAiKey(plain, TEST_KEY)
    await expect(decryptAiKey(encrypted, 'wrong-key-that-is-also-32-bytes!!')).rejects.toThrow()
  })

  it('throws on tampered ciphertext', async () => {
    const plain = 'do-not-touch'
    const encrypted = await encryptAiKey(plain, TEST_KEY)
    const tampered = encrypted.slice(0, -3) + 'abc'
    await expect(decryptAiKey(tampered, TEST_KEY)).rejects.toThrow()
  })

  it('throws on an unknown envelope prefix', async () => {
    await expect(decryptAiKey('v3:abcdef', TEST_KEY)).rejects.toThrow(
      'Unsupported encryption version'
    )
  })

  it('throws on empty string without version', async () => {
    await expect(decryptAiKey('', TEST_KEY)).rejects.toThrow('Unsupported encryption version')
  })

  it('handles empty plain text key', async () => {
    const encrypted = await encryptAiKey('', TEST_KEY)
    const decrypted = await decryptAiKey(encrypted, TEST_KEY)
    expect(decrypted).toBe('')
  })

  it('round-trips with a 64-character hex passphrase', async () => {
    const plain = 'sk-my-secret-api-key-12345'
    const encrypted = await encryptAiKey(plain, LONG_HEX_KEY)
    const decrypted = await decryptAiKey(encrypted, LONG_HEX_KEY)
    expect(decrypted).toBe(plain)
  })

  it('round-trips with a 64-character ascii passphrase', async () => {
    const plain = 'sk-my-secret-api-key-12345'
    const encrypted = await encryptAiKey(plain, LONG_ASCII_KEY)
    const decrypted = await decryptAiKey(encrypted, LONG_ASCII_KEY)
    expect(decrypted).toBe(plain)
  })

  it('round-trips with a 6-character short passphrase', async () => {
    const plain = 'sk-my-secret-api-key-12345'
    const encrypted = await encryptAiKey(plain, SHORT_KEY)
    const decrypted = await decryptAiKey(encrypted, SHORT_KEY)
    expect(decrypted).toBe(plain)
  })
})

// D10 (ahaqqu/RumaQ#523 P2, plan §3.6): the v2: envelope authenticates the
// provider row id as AES-GCM additional data.
describe('encryptAiKey / decryptAiKey with additional data (D10)', () => {
  const AAD = 'ai_provider:p-1'

  it('writes a v2: envelope when additional data is supplied', async () => {
    const encrypted = await encryptAiKey('sk-bound', TEST_KEY, AAD)
    expect(encrypted).toMatch(/^v2:/)
    await expect(decryptAiKey(encrypted, TEST_KEY, AAD)).resolves.toBe('sk-bound')
  })

  it("refuses the ciphertext under another row's additional data (the transplant case)", async () => {
    const encrypted = await encryptAiKey('sk-bound', TEST_KEY, AAD)
    await expect(decryptAiKey(encrypted, TEST_KEY, 'ai_provider:p-2')).rejects.toThrow()
  })

  it('refuses a v2: ciphertext opened without the context', async () => {
    const encrypted = await encryptAiKey('sk-bound', TEST_KEY, AAD)
    await expect(decryptAiKey(encrypted, TEST_KEY)).rejects.toThrow(
      'v2: envelope requires additional data'
    )
  })

  it('keeps v1: readable with no AAD and ignores an AAD passed to it', async () => {
    // A v1 ciphertext could not have authenticated an AAD, so a v1 read never
    // applies one — that is what makes the lazy v1→v2 rewrite possible.
    const encrypted = await encryptAiKey('sk-legacy', TEST_KEY)
    await expect(decryptAiKey(encrypted, TEST_KEY)).resolves.toBe('sk-legacy')
    await expect(decryptAiKey(encrypted, TEST_KEY, AAD)).resolves.toBe('sk-legacy')
  })

  it('an empty-string AAD still selects the v2: envelope', async () => {
    const encrypted = await encryptAiKey('sk-empty-aad', TEST_KEY, '')
    expect(encrypted).toMatch(/^v2:/)
    await expect(decryptAiKey(encrypted, TEST_KEY, '')).resolves.toBe('sk-empty-aad')
  })
})
