// Constant-time string comparison for bearer-token checks. Compares SHA-256
// digests so the loop length is fixed regardless of input lengths, and works
// on both the Workers runtime and Node (test) WebCrypto.
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ])
  const bytesA = new Uint8Array(digestA)
  const bytesB = new Uint8Array(digestB)
  let diff = 0
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i]! ^ bytesB[i]!
  }
  return diff === 0
}

export function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(str: string): ArrayBuffer {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer as ArrayBuffer
}

async function deriveAesKey(
  keyMaterial: string,
  usages: Extract<KeyUsage, 'encrypt' | 'decrypt'>[]
): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyMaterial),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode('rumaq-ai-key-v1'),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  )
}

export async function encryptAiKey(plainText: string, key: string): Promise<string> {
  const encoder = new TextEncoder()
  const aesKey = await deriveAesKey(key, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    encoder.encode(plainText)
  )
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return `v1:${base64UrlEncode(combined)}`
}

export async function decryptAiKey(cipherText: string, key: string): Promise<string> {
  if (!cipherText.startsWith('v1:')) {
    throw new Error('Unsupported encryption version')
  }
  const raw = cipherText.slice(3)
  const combined = new Uint8Array(base64UrlDecode(raw))
  const iv = combined.slice(0, 12)
  const data = combined.slice(12)
  const aesKey = await deriveAesKey(key, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, aesKey, data)
  return new TextDecoder().decode(plain)
}
