// Publish client — POST the ingest payload to RumaQ with bearer auth and
// retry/backoff (docs/plan/haqita-integration.md §6 publish/). PR2 defaults
// to dry-run (payload written to the state dir); --publish hits the real
// endpoint once RUMAQ_INGEST_URL is configured. Credential rejection and
// missing config are fatal (never retried); server errors back off.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Data, Effect } from 'effect'

import { withRetries } from '../util/retry.js'
import type { IngestPayload } from './payload.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class PublishConfigError extends Data.TaggedError('PublishConfigError')<{
  message: string
}> {}

/** 401/403 from the ingest endpoint — a bad secret never succeeds on retry. */
export class PublishRejected extends Data.TaggedError('PublishRejected')<{
  status: number
  message: string
}> {}

/** Retryable publish failure (server error, transport, bad response body). */
export class PublishError extends Data.TaggedError('PublishError')<{
  message: string
}> {}

export type PublishFailure = PublishConfigError | PublishRejected | PublishError

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

function resolveConfig(
  options: PublishOptions
): Effect.Effect<{ url: string; secret: string }, PublishConfigError> {
  return Effect.suspend(() => {
    const url = options.ingestUrl ?? process.env.RUMAQ_INGEST_URL
    const secret = options.ingestSecret ?? process.env.RUMAQ_INGEST_SECRET
    if (!url)
      return Effect.fail(
        new PublishConfigError({ message: 'RUMAQ_INGEST_URL not set — cannot publish' })
      )
    if (!secret)
      return Effect.fail(
        new PublishConfigError({ message: 'RUMAQ_INGEST_SECRET not set — cannot publish' })
      )
    return Effect.succeed({ url, secret })
  })
}

function postPayload(
  payload: IngestPayload,
  options: PublishOptions
): Effect.Effect<PublishResult['response'], PublishFailure> {
  const fetchFn = options.fetch ?? fetch
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 5000
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})

  return resolveConfig(options).pipe(
    Effect.flatMap(({ url, secret }) =>
      withRetries(
        Effect.tryPromise({
          try: () =>
            fetchFn(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${secret}`,
              },
              body: JSON.stringify(payload),
            }),
          catch: (cause: unknown) =>
            new PublishError({ message: `Ingest POST failed: ${String(cause)}` }),
        }).pipe(
          Effect.flatMap(
            (
              response
            ): Effect.Effect<PublishResult['response'], PublishRejected | PublishError> => {
              if (response.status === 401 || response.status === 403) {
                return Effect.fail(
                  new PublishRejected({
                    status: response.status,
                    message: `Ingest endpoint rejected credentials (HTTP ${response.status})`,
                  })
                )
              }
              if (!response.ok) {
                return Effect.fail(
                  new PublishError({ message: `Ingest endpoint returned HTTP ${response.status}` })
                )
              }
              return Effect.tryPromise({
                try: () => response.json() as Promise<PublishResult['response']>,
                catch: (cause: unknown) =>
                  new PublishError({ message: `Ingest response was not JSON: ${String(cause)}` }),
              })
            }
          )
        ),
        {
          retries,
          backoffMs,
          sleep,
          log,
          context: 'publish',
          isFatal: (error) => (error as { _tag?: string })._tag === 'PublishRejected',
        }
      )
    )
  )
}

export function publishPayload(
  payload: IngestPayload,
  options: PublishOptions
): Effect.Effect<PublishResult, PublishFailure> {
  return Effect.suspend(() => {
    if (!options.dryRun) {
      return postPayload(payload, options).pipe(
        Effect.map((response) => ({ mode: 'published', response }) as PublishResult)
      )
    }
    const file = path.join(
      options.stateDir,
      `payload-${payload.scrapedAt.replace(/[:.]/g, '-')}.json`
    )
    return Effect.tryPromise({
      try: async () => {
        await mkdir(options.stateDir, { recursive: true })
        await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      },
      catch: (cause: unknown) =>
        new PublishError({ message: `Dry-run payload write failed: ${String(cause)}` }),
    }).pipe(Effect.map(() => ({ mode: 'dry-run', payloadFile: file }) as PublishResult))
  })
}
