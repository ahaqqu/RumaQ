// Receipt image policy + storage composition (#503). The receipts domain's
// analog of the vault's wiring split: the pure policy below (validation, key
// building, extension mapping) plus `receiptsStorage`, the ONE place that
// reads the RECEIPTS binding and turns it into a StorageAdapter (the same
// registry-builds-ports-from-wiring pattern plugins/registry.ts uses for the
// vault's DOCUMENTS binding). Route code in apps/api.ts consumes the port and
// never touches the binding — the receipts-storage boundary pins in
// plugin-boundary.test.ts fail the build if that drifts.
//
// The key layout is load-bearing and deliberately untouched: objects live at
// receipts/<household_id>/<yyyy>/<mm>/<uuid>.<ext> inside the same physical
// bucket the vault uses (under its documents/ prefix). The StorageAdapter is
// key-transparent, so routing IO through the port moves no bytes and no
// migration is involved.
//
// getSignedUrl stays a null stub on purpose: the StorageAdapter contract
// forbids signed URLs for private objects (ports/storage/index.ts — the
// receipt-proxy pattern, docs/ARCHITECTURE.md §10), so a scan answer can only
// ever hand back imageUrl: null.
import { createR2StorageAdapter } from '../ports/storage/r2.js'
import { missingBindingAdapter } from '../ports/storage/missing.js'
import type { StorageAdapter } from '../ports/storage/index.js'
import type { Env } from '../types.js'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/webp'])
const MAX_SIZE = 5 * 1024 * 1024

const EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
}

export function validateImage(file: { type: string; size: number }): string | null {
  if (!ALLOWED_TYPES.has(file.type)) {
    return 'Unsupported file type. Accepted: JPEG, PNG, HEIC, WEBP.'
  }
  if (file.size > MAX_SIZE) {
    return 'File too large. Maximum size is 5 MB.'
  }
  return null
}

export function buildKey(householdId: string, userId: string, ext: string): string {
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const uuid = crypto.randomUUID()
  return `receipts/${householdId}/${yyyy}/${mm}/${uuid}.${ext}`
}

/**
 * The receipts StorageAdapter, built from the RECEIPTS binding wiring — the
 * receipts domain's composition root, mirroring the vault's
 * `env.DOCUMENTS ? createR2StorageAdapter(...) : missingBindingAdapter(...)`
 * in plugins/registry.ts (V1-A1 call-time refusal when the binding is
 * mis-wired, contract parity pinned in receipts-storage.test.ts).
 *
 * The former `uploadReceipt(bucket, …)` R2Bucket-shaped helper is gone: the
 * scan route now calls `receiptsStorage(env).put(...)` on the port. The one
 * write-side delta is R2 `customMetadata.uploadedAt`, which the port does not
 * represent — nothing ever read it back (it predates the port; the vault never
 * wrote per-object metadata either), so the swap is reader-invisible.
 */
export function receiptsStorage(env: Env['Bindings']): StorageAdapter {
  return env.RECEIPTS ? createR2StorageAdapter(env.RECEIPTS) : missingBindingAdapter('RECEIPTS')
}

export function getSignedUrl(): null {
  return null
}

export function extFromType(type: string): string {
  return EXT_MAP[type] || 'jpg'
}
