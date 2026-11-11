// The DokumenQ implementation of the StorageAdapter port (ahaqqu/RumaQ#442 —
// plugin architecture T8, Mode A: "apps authorize, the service serves",
// ahaqqu/DokumenQ docs/DESIGN.md §2). The registry (plugins/registry.ts) and
// the receipts composition (lib/receipts.ts) build this adapter through
// ./select.ts when the deployment is cut over; plugin code and routes never
// see it — they keep consuming the UNCHANGED StorageAdapter contract.
//
// Mode A wire shape (ahaqqu/DokumenQ docs/API.md §3.3/§4): every adapter call
// is app-token authorized. put() mints a signed PUT via POST /v1/authorize
// and streams the bytes server-side to it; get() mints a signed GET and
// streams the response body back through the port; delete() rides the
// app-token CRUD. The short-TTL signed URL exists ONLY inside one adapter
// call — fetched by the Worker, never handed to a browser, never persisted
// (the offline-engine boundary, DokumenQ clients/offline §2: the engine NEVER
// holds tokens, credentials, or pre-signed URLs — and neither does any
// RumaQ client surface; ports/storage/index.ts records the trust model).
//
// Why a deterministic doc_id: DokumenQ addresses objects by doc_id (ULID or
// RFC 4122 UUID), while this port addresses them by RumaQ key
// (documents/…, receipts/…). The adapter derives a UUIDv5-shaped id (SHA-256
// over the key, RFC 4122 version/variant bits) so the SAME key always maps
// to the SAME document: a retried put() after a lost response re-derives the
// id, and DokumenQ's create-only byte path answers 409 `document_exists`
// with the stored digest — reconciled here against our own declared digest
// (DESIGN §9.1.9: "reconciled by the adapter against the declared digest,
// not treated as an error"). The mapping is injective over the key space
// (2^122) and carries no secrecy: every byte path is app-token gated.
//
// Not the offline client: DokumenQ's clients/offline package is browser-side
// and REFUSES to hold credentials by design (its §2 boundary — config shaped
// like a credential throws at construction). The Worker's server-side Mode A
// surface is the other half of that contract, so this adapter speaks the four
// app-token endpoints with plain fetch — no SDK, no runtime dependency
// (docs/BACKEND_CONVENTIONS.md: a small built-in Web API beats a dependency).
import type { StorageAdapter, StoredObject } from './index.js'
import { sha256HexBytes } from '../../lib/crypto.js'

/** Mode A configuration — the base URL is plain config, the app secret is a
 *  Worker secret (DOKUMENQ_APP_SECRET, set out-of-band; never in the repo). */
export type DokumenQStorageConfig = {
  /** Service origin, e.g. https://dokumenq.ahaqqu.com (no trailing slash). */
  baseUrl: string
  /** The registered app's bearer secret (DokumenQ API.md §1.1, app token). */
  appSecret: string
  /** Injectable transport for tests; production uses the global fetch. */
  fetch?: typeof fetch
}

/**
 * Raised when DokumenQ answers something the port contract cannot honor.
 * `status` is the service's HTTP status (0 for transport-level failures),
 * `code` the stable error envelope code when one arrived. Routes keep
 * mapping storage rejections to their existing typed 5xx — these types make
 * the log line name the real failure instead of an opaque TypeError.
 */
export class DokumenQStorageError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'DokumenQStorageError'
    this.status = status
    this.code = code
  }
}

/** 401 from DokumenQ — the DOKUMENQ_APP_SECRET is wrong, revoked or rotated
 *  away. A credential problem, never a per-request condition. */
export class DokumenQUnauthorizedError extends DokumenQStorageError {
  constructor(message: string) {
    super(401, 'unauthorized', message)
    this.name = 'DokumenQUnauthorizedError'
  }
}

/** 429 from DokumenQ — a §5.7 bucket tripped. Carries the service's
 *  Retry-After seconds when the response declared one. */
export class DokumenQRateLimitedError extends DokumenQStorageError {
  readonly retryAfterSeconds: number | null
  constructor(message: string, retryAfterSeconds: number | null) {
    super(429, 'rate_limited', message)
    this.name = 'DokumenQRateLimitedError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** 409 whose stored digest does NOT match our own — same key, different
 *  bytes. DokumenQ's create-only byte path refuses to overwrite; the port
 *  has no overwrite either, so this is a data-integrity refusal, never a
 *  retryable condition. */
export class DokumenQDigestMismatchError extends DokumenQStorageError {
  constructor(message: string) {
    super(409, 'document_exists', message)
    this.name = 'DokumenQDigestMismatchError'
  }
}

/** The authorize/byte TTL the adapter requests (seconds). The service clamps
 *  to its own cap (DOKUMENQ_SIGNED_URL_TTL_MAX, ≤ 300 s); 60 keeps the
 *  window tight around a transfer that starts immediately. */
const SIGNED_URL_TTL_SECONDS = 60

/** The collection label every RumaQ object carries in DokumenQ's manifest —
 *  an opaque ops handle (list-by-collection), not an authorization boundary
 *  (the app token is). */
const RUMAQ_COLLECTION = 'rumaq'

/** DokumenQ subject cap (API.md §4.1: ≤ 128 bytes, no control characters). */
const SUBJECT_MAX_BYTES = 128

/**
 * DokumenQ's declared-mime allowlist (API.md §5.3 delta 7: only these are
 * accepted; anything else is a 415 before the body is read). The bridge
 * below maps a port call declaring a mime OUTSIDE this set onto
 * `application/octet-stream` — the service's passthrough declaration
 * ("no sniff") — so every object RumaQ stores today stays storable through
 * the cutover. The known case is receipts' image/heic: RumaQ byte-sniffs it
 * (#606) and stores it today; DokumenQ's allowlist does not carry it.
 *
 * Behavior delta, disclosed: a bridged object's manifest mime (and so the
 * signed GET's Content-Type) is application/octet-stream, not the declared
 * type — the receipts route serves `stored.contentType` directly, so a HEIC
 * receipt streams as a download instead of `image/heic` after cutover. The
 * D1 row keeps the original mime; the bytes are identical either way. The
 * trust posture is unchanged: the WORKER already validated the bytes (vault
 * sniff + receipts #606) before this adapter ever runs, and the sha256 the
 * authorize descriptor carries is verified at completion regardless.
 */
const DOKUMENQ_MIME_ALLOWLIST = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/zip',
  'text/plain',
])
const OCTET_STREAM = 'application/octet-stream'

/**
 * The deterministic key → doc_id map (see the header comment). SHA-256 over
 * the UTF-8 key, first 16 digest bytes shaped with RFC 4122 version 4 +
 * variant bits, lowercase hyphenated — a valid UUID by format, derived by
 * SHA-256 rather than SHA-1 (UUIDv5's hash) because nothing outside this
 * adapter ever re-derives it; the format is what the service validates.
 * Exported because determinism IS the contract: ops can recompute a key's
 * doc_id, and the tests pin the mapping's stability.
 */
export async function docIdForKey(key: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  )
  const bytes = digest.slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // RFC 4122 version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant 10xx
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * The authorize `subject` (API.md §4.1: trimmed, non-empty, ≤ 128 bytes, no
 * control characters — stored raw, never entering URLs or audit rows as
 * itself). The RumaQ key rides verbatim so ops can list-by-subject; keys
 * that would exceed the cap fall back to their SHA-256 fingerprint.
 */
async function subjectForKey(key: string): Promise<string> {
  const byteLength = new TextEncoder().encode(key).byteLength
  const hasControlChar = [...key].some((ch) => {
    const code = ch.codePointAt(0)!
    return code < 0x20 || code === 0x7f
  })
  if (byteLength <= SUBJECT_MAX_BYTES && !hasControlChar) {
    return key
  }
  return sha256HexBytes(new TextEncoder().encode(key))
}

type ErrorEnvelope = {
  error?: { code?: string; message?: string; existing?: { sha256?: string } } | string
}

/** Parse either the typed envelope `{error:{code,message}}` (API.md §7) or
 *  the rate limiter's plain-string body `{error:"rate limit exceeded"}`
 *  (API.md §6) — or nothing at all (bare 404s, HTML from a proxy). */
async function envelopeOf(res: Response): Promise<ErrorEnvelope> {
  try {
    return (await res.json()) as ErrorEnvelope
  } catch {
    return {}
  }
}

function messageOf(res: Response, body: ErrorEnvelope, fallback: string): string {
  if (typeof body.error === 'string') return body.error
  if (body.error && typeof body.error === 'object' && body.error.message) {
    return body.error.message
  }
  return `${fallback} (HTTP ${res.status})`
}

/** Map any non-OK DokumenQ response to the typed error family. The 404 paths
 *  never reach this: get/delete resolve them into the port's own semantics
 *  (null / idempotent success) BEFORE mapping. */
async function mapError(res: Response, fallback: string): Promise<DokumenQStorageError> {
  const body = await envelopeOf(res)
  const message = messageOf(res, body, fallback)
  if (res.status === 401) return new DokumenQUnauthorizedError(message)
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After'))
    return new DokumenQRateLimitedError(
      message,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
    )
  }
  const code =
    typeof body.error === 'object' && body.error?.code ? body.error.code : `http_${res.status}`
  return new DokumenQStorageError(res.status, code, message)
}

/** The DokumenQ implementation of StorageAdapter (Mode A). */
export function createDokumenQStorageAdapter(config: DokumenQStorageConfig): StorageAdapter {
  const doFetch = config.fetch ?? fetch
  const base = config.baseUrl.replace(/\/+$/, '')

  const authorize = async (body: Record<string, unknown>): Promise<Response> => {
    try {
      return await doFetch(`${base}/v1/authorize`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.appSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      throw new DokumenQStorageError(0, 'network', `DokumenQ unreachable: ${String(cause)}`)
    }
  }

  // The key's filename rides to the signed PUT as a sanitized Content-
  // Disposition (API.md §3.3) — cosmetic manifest metadata, never a path.
  const filenameFor = (key: string): string => key.split('/').pop() ?? 'upload.bin'

  return {
    async put(key, bytes, contentType) {
      const docId = await docIdForKey(key)
      const subject = await subjectForKey(key)
      // The port hands a Uint8Array (ArrayBufferLike at the type level); every
      // caller passes bytes backed by a dedicated ArrayBuffer — file bytes
      // from parseUpload, fixture literals in tests — which TS 7's
      // buffer-backed-view generics cannot see through the port's signature.
      // One documented downcast, reused for both the digest and the body.
      const payload = bytes as Uint8Array<ArrayBuffer>
      const digest = await sha256HexBytes(payload)
      // The allowlist bridge (header comment): declare what the service
      // accepts, never 415 an object RumaQ already validated. The transfer's
      // own Content-Type header follows the signed declaration — the service
      // enforces the signed t=, not this header (API.md §3.3 step 9).
      const declaredMime = DOKUMENQ_MIME_ALLOWLIST.has(contentType) ? contentType : OCTET_STREAM

      const mint = await authorize({
        method: 'put',
        doc_id: docId,
        size: payload.byteLength,
        mime: declaredMime,
        subject,
        sha256: digest,
        collection: RUMAQ_COLLECTION,
        ttl: SIGNED_URL_TTL_SECONDS,
      })
      if (!mint.ok) throw await mapError(mint, 'DokumenQ authorize failed')
      const { url } = (await mint.json()) as { url?: string }
      if (!url) {
        throw new DokumenQStorageError(500, 'internal_error', 'DokumenQ authorize returned no url')
      }

      let upload: Response
      try {
        upload = await doFetch(url, {
          method: 'PUT',
          headers: {
            'content-type': declaredMime,
            'content-disposition': `attachment; filename="${filenameFor(key)}"`,
          },
          body: payload,
          // A signed URL must serve exactly the transfer it was minted for —
          // a redirect is tampering, fail closed (clients/offline §2 pins the
          // same option browser-side).
          redirect: 'error',
        })
      } catch (cause) {
        throw new DokumenQStorageError(0, 'network', `DokumenQ upload failed: ${String(cause)}`)
      }
      if (upload.ok) return

      if (upload.status === 409) {
        // Create-only byte path (API.md §3.3): a retried put that lost its
        // 201 reconciles against the stored digest — match = already synced.
        const body = await envelopeOf(upload)
        const existing =
          body.error && typeof body.error === 'object' ? body.error.existing : undefined
        if (existing?.sha256 === digest) return
        throw new DokumenQDigestMismatchError(
          `DokumenQ already holds different bytes for this key (existing sha256 ${existing?.sha256 ?? 'unknown'}, ours ${digest})`
        )
      }
      throw await mapError(upload, 'DokumenQ upload failed')
    },

    async get(key): Promise<StoredObject | null> {
      const docId = await docIdForKey(key)
      const subject = await subjectForKey(key)

      const mint = await authorize({
        method: 'get',
        doc_id: docId,
        subject,
        ttl: SIGNED_URL_TTL_SECONDS,
      })
      if (mint.status === 404) return null // uniform not_found (API.md §1.3)
      if (!mint.ok) throw await mapError(mint, 'DokumenQ authorize failed')
      const { url } = (await mint.json()) as { url?: string }
      if (!url) {
        throw new DokumenQStorageError(500, 'internal_error', 'DokumenQ authorize returned no url')
      }

      let stream: Response
      try {
        stream = await doFetch(url, { redirect: 'error' })
      } catch (cause) {
        throw new DokumenQStorageError(0, 'network', `DokumenQ fetch failed: ${String(cause)}`)
      }
      if (stream.status === 404) return null // raced a delete/GC after minting — port's not-found
      if (!stream.ok) throw await mapError(stream, 'DokumenQ fetch failed')
      if (!stream.body) {
        throw new DokumenQStorageError(500, 'internal_error', 'DokumenQ fetch returned no body')
      }
      return {
        contentType: stream.headers.get('content-type'),
        // The port documents `size` as the exact stored length; DokumenQ
        // serves it as Content-Length on the signed GET. No current port
        // consumer reads size (routes stream `body` and read `contentType`
        // only) — a consumer that ever needs a guaranteed size should read
        // the metadata endpoint or land Mode B.
        size: Number(stream.headers.get('content-length') ?? 0),
        stream: stream.body,
      }
    },

    async delete(key) {
      const docId = await docIdForKey(key)
      let res: Response
      try {
        res = await doFetch(`${base}/v1/documents/${docId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${config.appSecret}` },
        })
      } catch (cause) {
        throw new DokumenQStorageError(0, 'network', `DokumenQ unreachable: ${String(cause)}`)
      }
      if (res.ok) return
      // Uniform 404 (API.md §1.3) covers unknown AND already-deleted — the
      // same idempotent-success contract the R2 adapter pins for retry-safe
      // deletion (ports/storage/r2.ts). Soft-deleted rows answer 404 too;
      // re-deleting a tombstone is a no-op, not an error.
      if (res.status === 404) return
      throw await mapError(res, 'DokumenQ delete failed')
    },
  }
}
