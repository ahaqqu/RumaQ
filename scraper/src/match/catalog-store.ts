// Catalog + embedding-cache persistence — the matcher's durable state in
// the state dir (catalog.json, embeddings.json), mirroring the novelty
// state's load/save idiom: typed IO errors, ENOENT is a fresh start, junk
// entries are dropped rather than crashing the daily run.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Data, Effect } from 'effect'

import { wrapIo } from '../util/io.js'
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
    const parsed = JSON.parse(await readFile(catalogFile, 'utf8')) as { entries?: unknown }
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
      io('write', catalogFile, () =>
        writeFile(catalogFile, JSON.stringify(catalog, null, 2) + '\n', 'utf8')
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
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as {
      model?: unknown
      vectors?: unknown
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
      io('write', cacheFile, () => writeFile(cacheFile, JSON.stringify(cache) + '\n', 'utf8'))
    )
  )
}
