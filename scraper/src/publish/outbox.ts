// Publish outbox — the run-<scrapedAt>.jsonl files are an at-least-once
// outbox, not just an audit trail. A crash between OCR and publish must not
// strand already-paid-for items: the next run loads every pending outbox
// file, includes their items in the payload, and retires the files only
// after a successful real publish (dry-runs never consume the outbox).
// Replaying is safe because the ingest endpoint upserts idempotently
// (ON CONFLICT product_id, source_id, observed_date — PR1).

import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { Data, Effect } from 'effect'

import { wrapIo } from '../util/io.js'
import type { ImageProducts } from './payload.js'

export class OutboxIo extends Data.TaggedError('OutboxIo')<{
  op: string
  path: string
  cause: unknown
  message: string
}> {}

/** Matches the files processStore writes: run-<ISO-scrapedAt>.jsonl */
const RUN_FILE_RE = /^run-.*\.jsonl$/

const io = wrapIo(OutboxIo)

/**
 * Load pending outbox items for a store: every line of every
 * `<stateDir>/<store>/run-*.jsonl`. Malformed lines are skipped with a log
 * line — one corrupt line must not block the publish of the rest.
 */
export function loadOutbox(
  stateDir: string,
  storeSlug: string,
  log?: (message: string) => void
): Effect.Effect<ImageProducts[], OutboxIo> {
  const storeDir = path.join(stateDir, storeSlug)
  const logger = log ?? (() => {})
  return io('readdir', storeDir, () => readdir(storeDir)).pipe(
    Effect.catchIf(
      (error) => (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT',
      () => Effect.succeed([] as string[])
    ),
    Effect.flatMap((names) =>
      Effect.forEach(
        names.filter((name) => RUN_FILE_RE.test(name)),
        (name) =>
          io('read', path.join(storeDir, name), () =>
            readFile(path.join(storeDir, name), 'utf8')
          ).pipe(
            Effect.flatMap((raw) =>
              Effect.succeed(
                raw
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0)
              )
            ),
            Effect.flatMap((lines) =>
              Effect.forEach(lines, (line) =>
                Effect.sync(() => {
                  try {
                    return JSON.parse(line) as ImageProducts
                  } catch {
                    logger(`[outbox] skipping malformed line in ${name}`)
                    return null
                  }
                })
              )
            ),
            Effect.map((entries) =>
              entries.filter((entry): entry is ImageProducts => entry !== null)
            )
          )
      )
    ),
    Effect.map((perFile) => perFile.flat())
  )
}

/**
 * Delete every outbox file for a store — called only after a successful
 * real publish whose payload covered the files' contents.
 */
export function retireOutbox(
  stateDir: string,
  storeSlug: string,
  log?: (message: string) => void
): Effect.Effect<void, OutboxIo> {
  const storeDir = path.join(stateDir, storeSlug)
  const logger = log ?? (() => {})
  return io('readdir', storeDir, () => readdir(storeDir)).pipe(
    Effect.catchIf(
      (error) => (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT',
      () => Effect.succeed([] as string[])
    ),
    Effect.flatMap((names) =>
      Effect.forEach(
        names.filter((name) => RUN_FILE_RE.test(name)),
        (name) =>
          io('rm', path.join(storeDir, name), () =>
            rm(path.join(storeDir, name), { force: true })
          ).pipe(
            Effect.map(() => {
              logger(`[outbox] retired ${storeSlug}/${name}`)
            })
          )
      )
    ),
    Effect.asVoid
  )
}
