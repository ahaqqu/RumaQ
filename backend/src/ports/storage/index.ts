// StorageAdapter — port #1 (ahaqqu/RumaQ#388 MVP; moved from lib/storage.ts
// to backend/src/ports/ by ticket 4, plugin architecture §4.2: "a backend/
// src/ports/ directory. StorageAdapter moves there from lib/storage.ts
// unchanged in shape"). The narrow seam between the vault's domain logic and
// wherever document bytes live. Two implementations sit beside it: the
// private R2 adapter (./r2.ts, the #388 MVP) and the DokumenQ Mode A adapter
// (./dokumenq.ts, #442 — the #391 storage pivot, self-hosted file service);
// ports/storage/select.ts picks per deployment, so the swap stays a config
// change — no route edits, no port edits.
//
// Trust model: every implementation talks to PRIVATE storage, and the Worker
// is the only component that ever touches credentials — no browser surface
// and no offline client holds tokens, credentials, or pre-signed URLs. That
// includes the DokumenQ offline engine (clients/offline §2: "the engine
// NEVER holds tokens, credentials, or pre-signed URLs") and, symmetrically,
// every RumaQ client: authorization is Worker-side, per call. Mode A (#442):
// the Worker authorizes with the DOKUMENQ_APP_SECRET and the byte transfer
// stays server-side — the short-TTL signed URL minted by POST /v1/authorize
// lives inside ONE adapter call (fetched by the Worker, dropped with the
// request), never handed to a client, never persisted. The invariant in
// words: no UNAUTHENTICATED byte path. Mode B (resolveSignedUrl — the port's
// additive V2 follow-up per docs/plan/plugin-architecture.md §4.2) will hand
// short-lived signed URLs to the browser for direct transfer per DokumenQ
// DESIGN §2.6; THIS comment is where that widening gets recorded when it
// lands, and no route may bypass the port to mint one before then.
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
