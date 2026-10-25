// Embedding client + cache tests — no network, injected client only.

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import { embedNames, emptyCache, type EmbeddingClient } from '../../src/match/embedding.js'
import {
  loadCatalog,
  loadEmbeddingCache,
  saveCatalog,
  saveEmbeddingCache,
} from '../../src/match/catalog-store.js'
import { emptyCatalog, type Catalog, type CatalogEntry } from '../../src/match/matcher.js'
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

describe('embedNames', () => {
  it('fills cache misses through the client and skips cached texts', async () => {
    const cache = emptyCache('m')
    cache.vectors['Cached'] = [1]
    let calls = 0
    const c: EmbeddingClient = {
      models: {
        batchEmbedContents: async (_args: { requests: { contents: string }[] }) => {
          calls++
          return { embeddings: [{ values: [calls] }] }
        },
      },
    }
    const vectors = await Effect.runPromise(
      embedNames(['Cached', 'Fresh'], cache, { model: 'm', client: c })
    )
    expect(calls).toBe(1)
    expect(vectors['Fresh']).toEqual([1])
    expect(vectors['Cached']).toEqual([1]) // untouched
  })

  it('batches misses — a cold cache pays one call per 100 texts, not per text', async () => {
    const cache = emptyCache('m')
    const texts = Array.from({ length: 150 }, (_, i) => `Name ${i}`)
    const batchSizes: number[] = []
    const c: EmbeddingClient = {
      models: {
        batchEmbedContents: async ({ requests }: { requests: { contents: string }[] }) => {
          batchSizes.push(requests.length)
          return { embeddings: requests.map(() => ({ values: [1, 2] })) }
        },
      },
    }
    const vectors = await Effect.runPromise(embedNames(texts, cache, { model: 'm', client: c }))
    expect(batchSizes).toEqual([100, 50])
    expect(Object.keys(vectors)).toHaveLength(150)
  })

  it('fails typed on empty vectors', async () => {
    const c: EmbeddingClient = {
      models: {
        batchEmbedContents: async () => ({ embeddings: [{ values: [] }] }),
      },
    }
    const exit = await Effect.runPromiseExit(
      embedNames(['X'], emptyCache('m'), { model: 'm', client: c })
    )
    expect(exit._tag).toBe('Failure')
  })
})

describe('catalog-store', () => {
  it('round-trips a catalog and an embedding cache', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rumaq-match-'))
    try {
      const entry: CatalogEntry = {
        productKey: 'indomie-goreng--indomie--85-g',
        name: 'Indomie Goreng',
        brand: 'Indomie',
        unit: '85 g',
        firstSeenAt: '2026-10-25T23:00:00Z',
        lastSeenAt: '2026-10-25T23:00:00Z',
        appearanceCount: 1,
        storesFound: ['superindo'],
        nameVariants: ['Indomie Goreng'],
        lastStoreSlug: 'superindo',
        lastPrice: 3500,
        lastEffectiveUnitPrice: 3500,
      }
      const catalog: Catalog = { entries: { [entry.productKey]: entry } }
      await Effect.runPromise(saveCatalog(catalog, path.join(dir, 'catalog.json')))
      const loaded = await Effect.runPromise(loadCatalog(path.join(dir, 'catalog.json')))
      expect(loaded).toEqual(catalog)

      const cache = emptyCache('m')
      cache.vectors['Indomie Goreng'] = [0.1, 0.2]
      await Effect.runPromise(saveEmbeddingCache(cache, path.join(dir, 'embeddings.json')))
      const loadedCache = await Effect.runPromise(
        loadEmbeddingCache(path.join(dir, 'embeddings.json'), 'm')
      )
      expect(loadedCache).toEqual(cache)

      // Atomic saves leave no temp files behind — only the target remains.
      expect(await readdir(dir)).toEqual(['catalog.json', 'embeddings.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a corrupt file is a fresh start, not a dead nightly job', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rumaq-match-'))
    try {
      // E.g. a catalog truncated by a crash before saves became atomic.
      await writeFile(path.join(dir, 'catalog.json'), '{"entries": {"indomie')
      await writeFile(path.join(dir, 'embeddings.json'), '{"model": "m", "vect')
      expect(await Effect.runPromise(loadCatalog(path.join(dir, 'catalog.json')))).toEqual(
        emptyCatalog()
      )
      expect(
        await Effect.runPromise(loadEmbeddingCache(path.join(dir, 'embeddings.json'), 'm'))
      ).toEqual(emptyCache('m'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('missing files are a fresh start, not an error', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rumaq-match-'))
    try {
      expect(await Effect.runPromise(loadCatalog(path.join(dir, 'nope.json')))).toEqual(
        emptyCatalog()
      )
      expect(await Effect.runPromise(loadEmbeddingCache(path.join(dir, 'nope.json'), 'm'))).toEqual(
        emptyCache('m')
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('discards vectors from a different embedding model', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rumaq-match-'))
    try {
      const file = path.join(dir, 'embeddings.json')
      await writeFile(file, JSON.stringify({ model: 'old-model', vectors: { A: [1] } }))
      const cache = await Effect.runPromise(loadEmbeddingCache(file, 'new-model'))
      expect(cache).toEqual(emptyCache('new-model'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drops junk entries instead of crashing the run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rumaq-match-'))
    try {
      const file = path.join(dir, 'catalog.json')
      await writeFile(
        file,
        JSON.stringify({
          entries: {
            good: {
              productKey: 'good',
              name: 'Good',
              brand: null,
              unit: null,
              firstSeenAt: 't',
              lastSeenAt: 't',
              appearanceCount: 1,
              storesFound: ['superindo'],
              nameVariants: ['Good'],
              lastStoreSlug: 'superindo',
              lastPrice: 1,
              lastEffectiveUnitPrice: 1,
            },
            junk: 'not-an-entry',
          },
        })
      )
      const catalog = await Effect.runPromise(loadCatalog(file))
      expect(Object.keys(catalog.entries)).toEqual(['good'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
