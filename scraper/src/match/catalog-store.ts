// Catalog + embedding-cache persistence — the matcher's durable state in
// the state dir (catalog.json, embeddings.json), mirroring the novelty
// state's load/save idiom: typed IO errors, ENOENT is a fresh start, junk
// entries (and corrupt JSON) are dropped rather than crashing the daily
// run. Saves are atomic (temp file + rename) so an interrupted write can
// never leave a truncated file behind.

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { Data, Effect } from 'effect'

import { writeFileAtomic, wrapIo } from '../util/io.js'
import { emptyCache, type EmbeddingCache } from './embedding.js'
import { emptyCatalog, type Catalog, type CatalogEntry } from './matcher.js'

export class CatalogIo extends Data.TaggedError('CatalogIo')<{
  op: string
  path: string
  cause: unknown
  message: string
}> {}

const io = wrapIo(CatalogIo)

function isEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<CatalogEntry>
  return typeof entry.productKey === 'string' && typeof entry.name === 'string'
}

export function loadCatalog(catalogFile: string): Effect.Effect<Catalog, CatalogIo> {
  return io('read', catalogFile, async () => {
    let parsed: { entries?: unknown }
    try {
      parsed = JSON.parse(await readFile(catalogFile, 'utf8')) as { entries?: unknown }
    } catch (cause) {
      // Real IO errors (unreadable file) keep their typed mapping; a corrupt
      // file — e.g. truncated by a crash before saves were atomic — starts
      // fresh instead of bricking every subsequent run (same philosophy as
      // junk-entry dropping below).
      if ((cause as NodeJS.ErrnoException)?.code) throw cause
      return emptyCatalog()
    }
    const entries: Record<string, CatalogEntry> = {}
    if (parsed.entries && typeof parsed.entries === 'object') {
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (isEntry(value)) entries[key] = value
      }
    }
    return { entries }
  }).pipe(
    Effect.catchIf(
      (error) => (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT',
      () => Effect.succeed(emptyCatalog())
    )
  )
}

export function saveCatalog(catalog: Catalog, catalogFile: string): Effect.Effect<void, CatalogIo> {
  return io('ensure-dir', path.dirname(catalogFile), () =>
    mkdir(path.dirname(catalogFile), { recursive: true })
  ).pipe(
    Effect.flatMap(() =>
      // Temp file + rename: a kill mid-save (OOM under MemoryMax=1G,
      // disk-full) must never leave a truncated catalog behind.
      io('write', catalogFile, () =>
        writeFileAtomic(catalogFile, JSON.stringify(catalog, null, 2) + '\n')
      )
    )
  )
}

/**
 * Load the embedding cache. A model change returns an empty cache — vectors
 * from different embedding models are incomparable, so stale vectors must
 * never be compared against fresh ones.
 */
export function loadEmbeddingCache(
  cacheFile: string,
  model: string
): Effect.Effect<EmbeddingCache, CatalogIo> {
  return io('read', cacheFile, async () => {
    let parsed: { model?: unknown; vectors?: unknown }
    try {
      parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as {
        model?: unknown
        vectors?: unknown
      }
    } catch (cause) {
      // Corrupt file (pre-atomic-write truncation): pay the re-embed cost,
      // never brick the run. Real IO errors keep their typed mapping.
      if ((cause as NodeJS.ErrnoException)?.code) throw cause
      return emptyCache(model)
    }
    if (parsed.model !== model || !parsed.vectors || typeof parsed.vectors !== 'object') {
      return emptyCache(model)
    }
    const vectors: Record<string, number[]> = {}
    for (const [text, value] of Object.entries(parsed.vectors)) {
      if (Array.isArray(value) && value.every((v) => typeof v === 'number')) vectors[text] = value
    }
    return { model, vectors }
  }).pipe(
    Effect.catchIf(
      (error) => (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT',
      () => Effect.succeed(emptyCache(model))
    )
  )
}

export function saveEmbeddingCache(
  cache: EmbeddingCache,
  cacheFile: string
): Effect.Effect<void, CatalogIo> {
  return io('ensure-dir', path.dirname(cacheFile), () =>
    mkdir(path.dirname(cacheFile), { recursive: true })
  ).pipe(
    Effect.flatMap(() =>
      io('write', cacheFile, () => writeFileAtomic(cacheFile, JSON.stringify(cache) + '\n'))
    )
  )
}
