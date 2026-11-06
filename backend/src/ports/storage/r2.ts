// The R2 implementation of the StorageAdapter port (ahaqqu/RumaQ#388 MVP;
// moved from lib/storage.ts beside the port itself by ticket 4, plugin
// architecture §4.2 — "the R2 adapter stays beside it (ports/storage/r2.ts)").
// The registry builds this adapter from the DOCUMENTS binding wiring and
// injects it into the documents plugin's factory (plugins/registry.ts) —
// plugin code never reads the binding.
import type { StorageAdapter } from './index.js'

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
