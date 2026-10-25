// Outbox tests — pending run-*.jsonl replay and retire-on-publish.

import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import { loadOutbox, retireOutbox } from '../../src/publish/outbox.js'
import type { ImageProducts } from '../../src/publish/payload.js'

const batch: ImageProducts = {
  storeSlug: 'superindo',
  brochureUrl: 'https://www.superindo.co.id/promosi/katalog-super-hemat/',
  products: [
    {
      name: 'Gula Pasir',
      brand: null,
      unit: '1 kg',
      price: 17000,
      promo: null,
      period: null,
      ocrRawPrice: '17000',
      imageSource: 'promo_abc.jpg',
    },
  ],
}

async function seedStoreDir(): Promise<string> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-outbox-'))
  const storeDir = path.join(stateDir, 'superindo')
  await mkdir(storeDir, { recursive: true })
  await writeFile(
    path.join(storeDir, 'run-2026-10-24T23-00-05-000Z.jsonl'),
    JSON.stringify(batch) + '\n'
  )
  await writeFile(
    path.join(storeDir, 'run-2026-10-25T23-00-05-000Z.jsonl'),
    JSON.stringify(batch) + '\n{not json}\n'
  )
  await writeFile(path.join(storeDir, 'state.json'), '{"lastRun":null,"processed":[]}')
  return stateDir
}

describe('loadOutbox', () => {
  it('collects lines from every run file and skips malformed lines', async () => {
    const stateDir = await seedStoreDir()
    const pending = await Effect.runPromise(loadOutbox(stateDir, 'superindo'))
    expect(pending).toEqual([batch, batch])
  })

  it('round-trips the extracting run timestamp; legacy lines simply lack it', async () => {
    const stateDir = await seedStoreDir()
    const storeDir = path.join(stateDir, 'superindo')
    await writeFile(
      path.join(storeDir, 'run-2026-10-23T23-00-05-000Z.jsonl'),
      JSON.stringify({ ...batch, scrapedAt: '2026-10-23T23:00:05.000Z' }) + '\n'
    )
    const pending = await Effect.runPromise(loadOutbox(stateDir, 'superindo'))
    expect(pending).toHaveLength(3)
    expect(pending[0]!.scrapedAt).toBe('2026-10-23T23:00:05.000Z')
    // Legacy lines carry no timestamp — buildPayload falls back to the
    // replay run's scrapedAt for them.
    expect(pending[1]!.scrapedAt).toBeUndefined()
  })

  it('returns [] when the store dir does not exist', async () => {
    const pending = await Effect.runPromise(loadOutbox('/nonexistent/rumaq', 'superindo'))
    expect(pending).toEqual([])
  })

  it('ignores non-run files', async () => {
    const stateDir = await seedStoreDir()
    const storeDir = path.join(stateDir, 'superindo')
    await writeFile(path.join(storeDir, 'notes.jsonl'), JSON.stringify(batch) + '\n')
    const pending = await Effect.runPromise(loadOutbox(stateDir, 'superindo'))
    expect(pending).toHaveLength(2)
  })
})

describe('retireOutbox', () => {
  it('deletes only run-*.jsonl files, leaving state and other files', async () => {
    const stateDir = await seedStoreDir()
    await writeFile(path.join(stateDir, 'superindo', 'notes.jsonl'), '[]\n')
    await Effect.runPromise(retireOutbox(stateDir, 'superindo'))
    const remaining = await readdir(path.join(stateDir, 'superindo'))
    expect(remaining.sort()).toEqual(['notes.jsonl', 'state.json'])
  })

  it('succeeds when the store dir does not exist', async () => {
    await Effect.runPromise(retireOutbox('/nonexistent/rumaq', 'superindo'))
  })
})
