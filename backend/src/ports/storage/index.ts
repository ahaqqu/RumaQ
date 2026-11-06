// StorageAdapter — port #1 (ahaqqu/RumaQ#388 MVP; moved from lib/storage.ts
// to backend/src/ports/ by ticket 4, plugin architecture §4.2: "a backend/
// src/ports/ directory. StorageAdapter moves there from lib/storage.ts
// unchanged in shape"). The narrow seam between the vault's domain logic and
// wherever document bytes live. The MVP implementation is the private R2
// adapter beside it (./r2.ts); the issue's storage pivot (#391 DokumenQ, a
// self-hosted file service) swaps in behind the same interface — a one-file
// change, no route edits.
//
// Trust model: this adapter only ever talks to PRIVATE buckets. No public
// URLs, no presigned URLs — every read is auth-scoped Worker code calling
// get() and streaming the body out itself (receipt-proxy pattern,
// docs/ARCHITECTURE.md §10). Keep it that way when swapping implementations.
//
// The key-building helpers are NOT here: they are vault policy, not port
// policy (§4.2), and live with the documents plugin
// (plugins/documents/keys.ts).

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
