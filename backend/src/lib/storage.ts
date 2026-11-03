// StorageAdapter (ahaqqu/RumaQ#388 MVP): the narrow seam between the vault's
// domain logic and wherever document bytes live. The MVP implementation is the
// private R2 adapter below; the issue's storage pivot (#391 DokumenQ, a
// self-hosted file service) swaps in behind the same interface — a one-file
// change, no route edits.
//
// Trust model: this adapter only ever talks to PRIVATE buckets. No public
// URLs, no presigned URLs — every read is auth-scoped Worker code calling
// get() and streaming the body out itself (receipt-proxy pattern,
// docs/ARCHITECTURE.md §10). Keep it that way when swapping implementations.

export type StoredObject = {
  /** The bytes' media type as stored at put() time. */
  contentType: string | null
  /** Exact byte length as stored. */
  size: number
  /** The object body. Consumed exactly once (a stream, per R2 semantics). */
  stream: ReadableStream<Uint8Array>
}

/**
 * Async put/get/delete over document bytes. Deliberately tiny (the MVP
 * directive's shape): no list (the D1 index owns listing), no signed URLs
 * (forbidden for this feature), no copy. Errors propagate as rejections —
 * routes map them to typed 5xx/4xx.
 */
export interface StorageAdapter {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<StoredObject | null>
  delete(key: string): Promise<void>
}

// One private bucket, two key namespaces (the issue's "bucket or hard-prefix"
// answer is hard-prefix): receipts/ (purchases) and documents/ (the vault).
// The DOCUMENTS binding points at the same private bucket as RECEIPTS — no
// new infrastructure, no shared code path.
export const DOCUMENTS_KEY_PREFIX = 'documents'

/** The only key shape the vault writes or reads — no traversal, no escapes. */
export function buildDocumentKey(householdId: string, documentId: string): string {
  return `${DOCUMENTS_KEY_PREFIX}/${householdId}/${documentId}`
}

/** Is this key one of ours? (The receipts namespace is never touched here.) */
export function isDocumentKey(key: string): boolean {
  const parts = key.split('/')
  return parts.length === 3 && parts[0] === DOCUMENTS_KEY_PREFIX
}

/** The R2 implementation of StorageAdapter. */
export function createR2StorageAdapter(bucket: R2Bucket): StorageAdapter {
  return {
    async put(key, bytes, contentType) {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType },
      })
    },

    async get(key) {
      const object = await bucket.get(key)
      if (!object) return null
      return {
        contentType: object.httpMetadata?.contentType ?? null,
        size: object.size,
        stream: object.body,
      }
    },

    async delete(key) {
      // R2 delete is idempotent — deleting an absent key succeeds. The route
      // relies on that for retry-safe deletion.
      await bucket.delete(key)
    },
  }
}
