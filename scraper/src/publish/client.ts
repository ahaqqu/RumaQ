// Publish client — POST the ingest payload to RumaQ with bearer auth and
// retry/backoff (docs/plan/haqita-integration.md §6 publish/). PR2 defaults
// to dry-run (payload written to the state dir); --publish hits the real
// endpoint once RUMAQ_INGEST_URL is configured.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { withRetries } from '../util/retry.js'
import type { IngestPayload } from './payload.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface PublishOptions {
  ingestUrl?: string
  ingestSecret?: string
  stateDir: string
  dryRun: boolean
  fetch?: FetchLike
  retries?: number
  backoffMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export interface PublishResult {
  mode: 'dry-run' | 'published'
  /** File the payload was written to (dry-run) — empty when published. */
  payloadFile?: string
  response?: {
    accepted: number
    productsCreated: number
    observationsUpserted: number
    skipped: number
  }
}

export class FatalPublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FatalPublishError'
  }
}

async function postPayload(
  payload: IngestPayload,
  options: PublishOptions
): Promise<PublishResult['response']> {
  const url = options.ingestUrl ?? process.env.RUMAQ_INGEST_URL
  const secret = options.ingestSecret ?? process.env.RUMAQ_INGEST_SECRET
  if (!url) throw new Error('RUMAQ_INGEST_URL not set — cannot publish')
  if (!secret) throw new Error('RUMAQ_INGEST_SECRET not set — cannot publish')
  const fetchFn = options.fetch ?? fetch
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 5000
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})

  return withRetries(
    async () => {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(payload),
      })
      if (response.status === 401 || response.status === 403) {
        // Bad secret never succeeds on retry — fail fast.
        throw new FatalPublishError(
          `Ingest endpoint rejected credentials (HTTP ${response.status})`
        )
      }
      if (!response.ok) {
        throw new Error(`Ingest endpoint returned HTTP ${response.status}`)
      }
      return (await response.json()) as PublishResult['response']
    },
    {
      retries,
      backoffMs,
      sleep,
      log,
      context: 'publish',
      isFatal: (error) => error instanceof FatalPublishError,
    }
  )
}

export async function publishPayload(
  payload: IngestPayload,
  options: PublishOptions
): Promise<PublishResult> {
  if (options.dryRun) {
    await mkdir(options.stateDir, { recursive: true })
    const file = path.join(
      options.stateDir,
      `payload-${payload.scrapedAt.replace(/[:.]/g, '-')}.json`
    )
    await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    return { mode: 'dry-run', payloadFile: file }
  }
  const response = await postPayload(payload, options)
  return { mode: 'published', response }
}
