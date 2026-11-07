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

// Deterministic SHA-256 fingerprint as lowercase hex — the lookup handle for
// secrets we must index (invite codes: hash for the UNIQUE join lookup) while
// the value itself is only stored encrypted (encryptAiKey below).
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

// The same fingerprint over raw bytes — the document vault (#388) hashes the
// uploaded file bytes (integrity column on documents.sha256). The view goes
// to the digest directly (BufferSource) — no copy of a 10 MB payload. The
// narrow ArrayBuffer-backed generic is what BufferSource demands; callers
// hold exactly that (file.data, literal-backed test bytes).
export async function sha256HexBytes(
  value: Uint8Array<ArrayBuffer> | ArrayBuffer
): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
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

// Two envelopes (ahaqqu/RumaQ#523 D10, plan §3.6):
//
//   v1:  AES-GCM, no additional data — everything written before #523 P2,
//        including the invite codes below (they are not AI keys and keep the
//        v1 wire; nothing binds them to a row).
//   v2:  AES-GCM with `additionalData` — the AI provider key is bound to its
//        `ai_providers.id` (`ai_provider:<id>`), so a ciphertext copied onto
//        another row fails the authentication tag instead of decrypting.
//
// The envelope is chosen by CALLER INTENT, not by inspecting the argument:
// no AAD means v1 (legacy/invite), an AAD — even the empty string — means v2.
// decryptAiKey dispatches on the prefix, so a v1 ciphertext ignores an AAD
// that could not have been authenticated at seal time.

const ENVELOPE_V1 = 'v1:'
const ENVELOPE_V2 = 'v2:'

export async function encryptAiKey(
  plainText: string,
  key: string,
  additionalData?: string
): Promise<string> {
  const encoder = new TextEncoder()
  const aesKey = await deriveAesKey(key, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = additionalData === undefined ? null : encoder.encode(additionalData)
  const ciphertext = await crypto.subtle.encrypt(
    // `additionalData: undefined` is not accepted by every WebCrypto
    // implementation; the key is omitted entirely for v1.
    aad === null
      ? { name: 'AES-GCM', iv, tagLength: 128 }
      : { name: 'AES-GCM', iv, tagLength: 128, additionalData: aad },
    aesKey,
    encoder.encode(plainText)
  )
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return `${aad === null ? ENVELOPE_V1 : ENVELOPE_V2}${base64UrlEncode(combined)}`
}

export async function decryptAiKey(
  cipherText: string,
  key: string,
  additionalData?: string
): Promise<string> {
  const isV2 = cipherText.startsWith(ENVELOPE_V2)
  if (!isV2 && !cipherText.startsWith(ENVELOPE_V1)) {
    throw new Error('Unsupported encryption version')
  }
  if (isV2 && additionalData === undefined) {
    // A v2 ciphertext was sealed with AAD; opening it without the context can
    // only produce a tag failure, so say why instead of a bare OperationError.
    throw new Error('v2: envelope requires additional data')
  }
  const raw = cipherText.slice(isV2 ? ENVELOPE_V2.length : ENVELOPE_V1.length)
  const combined = new Uint8Array(base64UrlDecode(raw))
  const iv = combined.slice(0, 12)
  const data = combined.slice(12)
  const aesKey = await deriveAesKey(key, ['decrypt'])
  const aad = isV2 ? new TextEncoder().encode(additionalData ?? '') : null
  const plain = await crypto.subtle.decrypt(
    aad === null
      ? { name: 'AES-GCM', iv, tagLength: 128 }
      : { name: 'AES-GCM', iv, tagLength: 128, additionalData: aad },
    aesKey,
    data
  )
  return new TextDecoder().decode(plain)
}
