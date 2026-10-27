// Pipeline orchestration: scrape → novelty filter → OCR → publish
// (docs/plan/haqita-integration.md §6 src/main.ts). Stage status is written
// to status.json on every exit so a failed run can be inspected without
// digging through logs; novelty state makes re-runs cheap. All failure
// modes collapse into one typed `PipelineFailure` carrying the process exit
// code (0 ok / 1 failure / 2 quota).

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Data, Effect } from 'effect'

import { loadConfig, type ScraperConfig } from './config.js'
import {
  loadCatalog,
  loadEmbeddingCache,
  saveCatalog,
  saveEmbeddingCache,
  type CatalogIo,
} from './match/catalog-store.js'
import type { EmbeddingClient } from './match/embedding.js'
import {
  runMatch,
  type MatchInputItem,
  type MatchOutcome,
  type MatchStats,
} from './match/matcher.js'
import {
  classifyImages,
  loadState,
  pruneImages,
  rememberProcessed,
  saveState,
  StateIo,
  type ScraperState,
} from './fetch/state.js'
import type { BrowserLauncher } from './fetch/browser.js'
import { BrowserTierRequired, type FetchError } from './fetch/errors.js'
import { storeProxyUrl } from './config.js'
import { createStoreFetcher, type FetchLike } from './fetch/strategy.js'
import { createOcr, type GeminiClient, type Ocr, type OcrError } from './ocr/gemini.js'
import { validateProduct, type ValidatedProduct } from './ocr/parse.js'
import { assertPayloadValid, buildPayload, type ImageProducts } from './publish/payload.js'
import { loadOutbox, retireOutbox, type OutboxIo } from './publish/outbox.js'
import { postRunReport } from './publish/runs.js'
import type { RunReport } from '@rumaq/contract'
import {
  publishPayload,
  type FetchLike as PublishFetch,
  type PublishFailure,
} from './publish/client.js'
import { activePlugins } from './stores/index.js'
import { isBrochurePlugin, type BrochureStorePlugin, type StorePlugin } from './stores/types.js'
import { wrapIo } from './util/io.js'
import { createLog, logRejectedItem, type LogFn } from './util/log.js'
import { QuotaExhausted } from './util/retry.js'

export class PipelineFailure extends Data.TaggedError('PipelineFailure')<{
  message: string
  exitCode: number
}> {}

export type PipelineStage = 'scrape' | 'match' | 'publish' | 'done'

export interface PipelineStatus {
  runStartedAt: string
  stage: PipelineStage
  match?: MatchStats
  /** Outcome of the publish stage — unset until publish was reached. */
  publish?: {
    mode: 'dry-run' | 'published'
    accepted?: number
    skipped?: number
  }
  stores: Record<
    string,
    {
      pagesFound: number
      newImages: number
      existingImages: number
      skipped: number
      itemsExtracted: number
      itemsRejected: number
      /** Set when this store's run failed — the run still publishes the rest. */
      error?: string
      /**
       * By-design skip (§2): a Tier-2 store the browser tier cannot reach
       * while its per-store proxy env var is unset. Expected, so the run
       * stays green and the monitor shows the gap per store.
       */
      needsProxy?: boolean
    }
  >
}

export interface PipelineOptions {
  stateDir: string
  /** Default true until go-live (PR4) flips the timer to --publish. */
  dryRun: boolean
  fetch?: FetchLike
  /** Tier-2 browser launcher override (tests inject a fake). */
  launcher?: BrowserLauncher
  ocrClient?: GeminiClient
  embedClient?: EmbeddingClient
  verifyClient?: GeminiClient
  /** Gemini API key override; defaults to GEMINI_API_KEY. */
  geminiApiKey?: string
  publishFetch?: PublishFetch
  /** Ingest endpoint overrides; default to the RUMAQ_INGEST_* env vars. */
  ingestUrl?: string
  ingestSecret?: string
  log?: LogFn
  /** Injectable sleep so tests never wait out real retry backoff. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock for deterministic scrapedAt in tests. */
  now?: () => Date
}

// Shared fs-IO wrapper (util/io.ts) — same tagged-error mapping as the
// state and outbox modules.
const ioTry = wrapIo(StateIo)

function writeStatus(stateDir: string, status: PipelineStatus): Effect.Effect<void> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(stateDir, { recursive: true })
      await writeFile(
        path.join(stateDir, 'status.json'),
        JSON.stringify(status, null, 2) + '\n',
        'utf8'
      )
    },
    // status.json is best-effort observability — never fails the run.
    catch: (cause: unknown) =>
      new StateIo({
        op: 'write',
        path: path.join(stateDir, 'status.json'),
        cause,
        message: `status write failed: ${String(cause)}`,
      }),
  }).pipe(Effect.ignore)
}

type StoreRunError = FetchError | StateIo | OcrError | QuotaExhausted | OutboxIo | CatalogIo

function processStore(
  plugin: BrochureStorePlugin,
  config: ScraperConfig,
  options: PipelineOptions,
  scrapedAt: string,
  entry: PipelineStatus['stores'][string],
  log: LogFn
): Effect.Effect<ImageProducts[], StoreRunError> {
  const store = plugin.config
  const stateFile = path.join(options.stateDir, store.slug, 'state.json')
  const imagesDir = path.join(
    options.stateDir,
    store.slug,
    'images',
    scrapedAt.slice(0, 10).replace(/-/g, '')
  )

  const fetcher = createStoreFetcher(store, {
    fetch: options.fetch,
    log,
    sleep: options.sleep,
    launcher: options.launcher,
  })
  const ocr: Ocr = createOcr({
    model: config.ocr.model,
    storeSlug: store.slug,
    // config.ocr.maxRetries counts retries (extra attempts), matching the
    // retry engine's naming — no total-vs-extra conversion needed.
    retries: config.ocr.maxRetries,
    client: options.ocrClient,
    sleep: options.sleep,
    log,
  })

  return Effect.gen(function* () {
    const pages = yield* plugin.listBrochurePages({
      fetchHtml: (url) => fetcher.fetchHtml(url),
      runStartedAt: scrapedAt,
    })
    entry.pagesFound = pages.length

    const state: ScraperState = yield* loadState(stateFile)
    const classified = yield* classifyImages(pages, state, {
      imagesDir,
      minImageSizeKb: config.novelty.minImageSizeKb,
      minDimensionPx: config.novelty.minDimensionPx,
      fetcher,
      log,
    })
    entry.newImages = classified.newImages.length
    entry.existingImages = classified.existingImages.length
    entry.skipped = classified.skipped.length

    const imageProducts: ImageProducts[] = []
    // Per-run items file: each image's validated items are appended as one
    // JSON line as soon as the image is OCR'd, so a crashed run leaves the
    // publishable payload on disk.
    const runItemsFile = path.join(
      options.stateDir,
      store.slug,
      `run-${scrapedAt.replace(/[:.]/g, '-')}.jsonl`
    )
    yield* ioTry('ensure-dir', path.dirname(runItemsFile), () =>
      mkdir(path.dirname(runItemsFile), { recursive: true })
    )

    for (const image of classified.newImages) {
      const bytes = yield* ioTry('read', image.filePath, () => readFile(image.filePath)).pipe(
        Effect.map((buffer) => new Uint8Array(buffer))
      )
      const rawItems = yield* ocr.ocrImage(bytes, image.contentType)
      const products: ValidatedProduct[] = []
      for (const raw of rawItems) {
        const [product, rejectReason] = validateProduct(raw, image.filename)
        if (product) {
          products.push(product)
        } else {
          entry.itemsRejected++
          yield* ioTry('append', path.join(options.stateDir, 'rejected-items.log'), () =>
            logRejectedItem(options.stateDir, {
              storeSlug: store.slug,
              imageFilename: image.filename,
              name: raw.name ? String(raw.name) : undefined,
              reason: rejectReason!,
            })
          )
        }
      }
      entry.itemsExtracted += products.length
      imageProducts.push({ storeSlug: store.slug, brochureUrl: image.brochureUrl, products })

      // Outbox BEFORE novelty state, per image: if the run dies (or the
      // append fails) between the two, the worst case is one duplicate OCR
      // of this image on the next run — never paid-for items stranded
      // outside every run-*.jsonl. A same-UTC-day recovery dedupes through
      // the (product_id, source_id, observed_date) upsert; a cross-day
      // recovery costs one extra re-observation row — bounded, and
      // preferable to stranding. The line carries this run's scrapedAt so a
      // later replay keeps the original observed date.
      yield* ioTry('append', runItemsFile, () =>
        appendFile(
          runItemsFile,
          JSON.stringify({
            storeSlug: store.slug,
            brochureUrl: image.brochureUrl,
            products,
            scrapedAt,
          }) + '\n',
          'utf8'
        )
      )
      rememberProcessed(state, image.md5)
      state.lastRun = scrapedAt
      yield* saveState(state, stateFile)
    }

    state.lastRun = scrapedAt
    yield* saveState(state, stateFile)

    return imageProducts
  }).pipe(
    // The browser session (Tier-2 stores) must never outlive the store's
    // run, whatever exit it takes; close() itself never throws.
    Effect.onExit(() => Effect.promise(() => fetcher.close()))
  )
}

function toPipelineFailure(error: unknown): PipelineFailure {
  if (error instanceof PipelineFailure) return error
  if (error instanceof QuotaExhausted) {
    return new PipelineFailure({ message: error.message, exitCode: 2 })
  }
  return new PipelineFailure({ message: String(error), exitCode: 1 })
}

/**
 * A needs-proxy skip is expected, not a failure: it neither reddens the run
 * nor holds its outbox back — the store fetched nothing this run, and its
 * pre-run pending items were already replayed into this run's payload.
 */
function storeFailed(entry: PipelineStatus['stores'][string]): boolean {
  return entry.error !== undefined && !entry.needsProxy
}

export function runPipeline(
  options: PipelineOptions
): Effect.Effect<PipelineStatus, PipelineFailure> {
  const log = options.log ?? createLog('pipeline')
  const config = loadConfig()
  const scrapedAt = (options.now ?? (() => new Date()))().toISOString()
  // activePlugins is the single source of truth for which stores run: both
  // the work list and the status map come from it, so they cannot drift.
  const runs: { plugin: StorePlugin; entry: PipelineStatus['stores'][string] }[] = activePlugins(
    config
  ).map((plugin) => ({
    plugin,
    entry: {
      pagesFound: 0,
      newImages: 0,
      existingImages: 0,
      skipped: 0,
      itemsExtracted: 0,
      itemsRejected: 0,
    },
  }))
  const status: PipelineStatus = {
    runStartedAt: scrapedAt,
    stage: 'scrape',
    stores: Object.fromEntries(runs.map(({ plugin, entry }) => [plugin.config.slug, entry])),
  }

  const program: Effect.Effect<PipelineStatus, StoreRunError | PublishFailure | PipelineFailure> =
    Effect.gen(function* () {
      // Outbox replay: items OCR'd by a previous run that never published
      // (crash, exhausted retries) are re-included here so paid-for Gemini
      // work always reaches D1. The ingest upsert makes replay idempotent.
      const allImageProducts: ImageProducts[] = []
      for (const { plugin } of runs) {
        const pending = yield* loadOutbox(options.stateDir, plugin.config.slug, log)
        if (pending.length > 0) {
          log(
            `[outbox] replaying ${pending.length} pending image batch(es) for ${plugin.config.slug}`
          )
        }
        allImageProducts.push(...pending)
      }

      for (const { plugin, entry } of runs) {
        if (!isBrochurePlugin(plugin)) {
          return yield* new PipelineFailure({
            message: `No brochure plugin for ${plugin.config.slug}`,
            exitCode: 1,
          })
        }
        // Per-store isolation: one store's fatal failure (a persistent
        // Incapsula challenge, a dead listing route, a missing chromium)
        // must not block the other stores' nightly publish — the healthy
        // store's paid-for OCR rides the outbox and would otherwise replay
        // (and fail again) for as long as the broken store stays broken.
        // QuotaExhausted deliberately propagates: the Gemini quota is shared
        // by every store, so there is nothing left to isolate.
        const imageProducts = yield* processStore(
          plugin,
          config,
          options,
          scrapedAt,
          entry,
          log
        ).pipe(
          Effect.catchIf(
            (error) => !(error instanceof QuotaExhausted),
            (error) =>
              Effect.sync(() => {
                // A Tier-2 store the browser tier cannot reach is a Tier-3
                // (per-store proxy) decision (§2). With the proxy env var
                // unset that is a permanent, expected state — not a nightly
                // failure: mark it and keep the run green until credentials
                // are configured; the monitor shows the gap on the store row.
                if (error instanceof BrowserTierRequired && !storeProxyUrl(plugin.config)) {
                  const envVar = plugin.config.proxyEnv ?? 'a per-store proxy env var'
                  entry.needsProxy = true
                  entry.error =
                    `Tier-3 proxy required but ${envVar} is not configured — ` +
                    'skipped by design (docs/plan/haqita-integration.md §2)'
                  log(
                    `[pipeline] store ${plugin.config.slug} needs a Tier-3 proxy ` +
                      `(${envVar} unset) — skipping by design, run stays green`
                  )
                  return [] as ImageProducts[]
                }
                log(
                  `[pipeline] store ${plugin.config.slug} failed — continuing with the remaining stores: ${String(error)}`
                )
                entry.error = String(error)
                return [] as ImageProducts[]
              })
          )
        )
        allImageProducts.push(...imageProducts)
      }

      // Match stage: every item (replayed outbox batches included — they were
      // never published, so they were never matched) resolves against the
      // persistent canonical catalog. Identity-keyed outcomes feed the
      // payload; the catalog and embedding cache checkpoint after the sweep.
      status.stage = 'match'
      const catalogFile = path.join(options.stateDir, 'catalog.json')
      const embeddingsFile = path.join(options.stateDir, 'embeddings.json')
      const matchInput: MatchInputItem[] = []
      for (const batch of allImageProducts) {
        for (const product of batch.products) {
          matchInput.push({ storeSlug: batch.storeSlug, product })
        }
      }
      const outcomeByProduct = new Map<ValidatedProduct, MatchOutcome>()
      if (matchInput.length > 0) {
        const catalog = yield* loadCatalog(catalogFile)
        const cache = yield* loadEmbeddingCache(embeddingsFile, config.consolidation.embeddingModel)
        const matched = yield* runMatch(
          matchInput,
          catalog,
          cache,
          {
            cfg: config.consolidation,
            embeddingModel: config.consolidation.embeddingModel,
            verifierModel: config.ocr.verifierModel,
            verifierRetries: config.consolidation.verifierRetries,
            storeNames: Object.fromEntries(config.stores.map((store) => [store.slug, store.name])),
            apiKey: options.geminiApiKey,
            embedClient: options.embedClient,
            verifyClient: options.verifyClient,
            sleep: options.sleep,
            log,
          },
          scrapedAt
        )
        status.match = matched.stats
        log(
          `[match] ${matched.stats.exact} exact, ${matched.stats.embedding} embedding, ` +
            `${matched.stats.ai} ai-verified, ${matched.stats.solo} new — ` +
            `${matched.stats.reviewItems} flagged for review` +
            (matched.stats.embeddingsDegraded ? ' (embeddings degraded: exact-only)' : '')
        )
        yield* saveCatalog(matched.catalog, catalogFile)
        // The cache is only mutated on embedding success; a failed sweep
        // persists whatever earlier runs accrued.
        yield* saveEmbeddingCache(matched.cache, embeddingsFile)
        matchInput.forEach((input, i) => {
          outcomeByProduct.set(input.product, matched.outcomes[i]!)
        })
      }

      status.stage = 'publish'
      const payload = buildPayload({
        stores: config.stores,
        images: allImageProducts,
        scrapedAt,
        outcomes: outcomeByProduct,
      })
      // Producer-side contract check: a schema violation is a pipeline bug and
      // exits 1 before the payload leaves the VPS (belt-and-braces for the
      // per-item date checks in buildPayload).
      yield* Effect.try({
        try: () => assertPayloadValid(payload),
        catch: (cause) => new PipelineFailure({ message: String(cause), exitCode: 1 }),
      })
      const result = yield* publishPayload(payload, {
        stateDir: options.stateDir,
        dryRun: options.dryRun,
        fetch: options.publishFetch,
        ingestUrl: options.ingestUrl,
        ingestSecret: options.ingestSecret,
        sleep: options.sleep,
        log,
      })
      status.publish = {
        mode: result.mode,
        accepted: result.response?.accepted,
        skipped: result.response?.skipped,
      }
      log(
        result.mode === 'dry-run'
          ? `[publish] Dry-run — payload written to ${result.payloadFile}`
          : `[publish] Accepted ${result.response?.accepted ?? 0} items`
      )
      // The outbox is consumed only by a real publish; a dry-run must leave
      // pending items in place for the next live run. A retire failure never
      // fails an already-published run (worst case: a harmless replay).
      if (result.mode === 'published') {
        for (const { plugin, entry } of runs) {
          // A store that failed mid-run kept appending OCR'd images to its
          // outbox after the payload was built — those items are not in this
          // publish, and the novelty state already skips their images. Only a
          // real failure keeps its file pending for the next run's replay; a
          // needs-proxy skip retires like a healthy store (it fetched nothing
          // this run, and its pre-run pending items are in this payload).
          if (storeFailed(entry)) {
            log(
              `[outbox] keeping ${plugin.config.slug} pending — its run failed; items replay next run`
            )
            continue
          }
          yield* retireOutbox(options.stateDir, plugin.config.slug, log).pipe(
            Effect.catchIf(
              () => true,
              (error) =>
                Effect.sync(() => {
                  log(`[outbox] retire failed for ${plugin.config.slug}: ${String(error)}`)
                })
            )
          )
        }
      }
      // Plan §6: image files are pruned 7 days after the run that published
      // them — the disk-scarce VPS must not accumulate dated image dirs. A
      // prune failure never fails an already-published run.
      for (const { plugin } of runs) {
        yield* pruneImages(path.join(options.stateDir, plugin.config.slug, 'images'), {
          now: (options.now ?? (() => new Date()))(),
          log,
        }).pipe(
          Effect.catchIf(
            () => true,
            (error) =>
              Effect.sync(() => {
                log(`[prune] ${plugin.config.slug}: ${String(error)}`)
              })
          )
        )
      }
      // A failed store must fail the run (red timer, non-zero exit) — but
      // only AFTER publish and outbox handling, so the healthy stores'
      // snapshot went out and the failed store's already-OCR'd items stay in
      // the outbox for the next run's replay. A needs-proxy skip is expected
      // and must not: the run stays green and the monitor shows the gap.
      const failed = runs.filter(({ entry }) => storeFailed(entry))
      if (failed.length > 0) {
        return yield* new PipelineFailure({
          message: `Store failure(s): ${failed
            .map(({ plugin, entry }) => `${plugin.config.slug}: ${entry.error}`)
            .join('; ')}`,
          exitCode: 1,
        })
      }
      status.stage = 'done'
      return status
    })

  // Run report (§7.1): one POST per finished live run — success or failure —
  // feeding the admin scraping monitor. Dry-runs (local/manual) never report.
  // Strictly best-effort: postRunReport already degrades an unconfigured
  // endpoint to a no-op, and Effect.ignore keeps a monitor outage from
  // touching the run's own outcome.
  function reportRun(
    status: PipelineStatus,
    options: PipelineOptions,
    log: LogFn,
    exitCode: 0 | 1 | 2,
    error?: string
  ): Effect.Effect<void> {
    if (options.dryRun) return Effect.void
    const finishedAt = (options.now ?? (() => new Date()))().toISOString()
    const match = status.match
    const report: RunReport = {
      schemaVersion: 1,
      runStartedAt: status.runStartedAt,
      finishedAt,
      exitCode,
      status: exitCode === 0 ? 'success' : 'failed',
      stage: status.stage,
      perStore: status.stores,
      match: match
        ? {
            exact: match.exact,
            embedding: match.embedding,
            ai: match.ai,
            solo: match.solo,
            reviewItems: match.reviewItems,
            embeddingsDegraded: match.embeddingsDegraded,
          }
        : null,
      publish: status.publish ?? null,
      error: error ?? null,
    }
    return postRunReport(report, {
      ingestUrl: options.ingestUrl,
      ingestSecret: options.ingestSecret,
      fetch: options.publishFetch,
      sleep: options.sleep,
      log,
    }).pipe(Effect.ignore)
  }

  return program.pipe(
    Effect.mapError(toPipelineFailure),
    Effect.tap((finalStatus) => reportRun(finalStatus, options, log, 0)),
    Effect.tapError((failure) =>
      reportRun(status, options, log, failure.exitCode as 0 | 1 | 2, failure.message)
    ),
    Effect.onExit(() => writeStatus(options.stateDir, status))
  )
}
