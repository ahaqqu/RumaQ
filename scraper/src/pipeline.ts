// Pipeline orchestration: scrape → novelty filter → OCR → publish
// (docs/plan/haqita-integration.md §6 src/main.ts). Stage status is written
// to status.json so a failed run can be inspected without digging through
// logs; novelty state makes re-runs cheap.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { loadConfig, type ScraperConfig, type StoreConfig } from './config.js'
import { classifyImages, loadState, saveState, type ScraperState } from './fetch/state.js'
import { createFetcher, type FetchLike } from './fetch/strategy.js'
import { createOcr, type GeminiClient, type Ocr } from './ocr/gemini.js'
import { validateProduct, type ValidatedProduct } from './ocr/parse.js'
import { buildPayload, type ImageProducts } from './publish/payload.js'
import { publishPayload, type FetchLike as PublishFetch } from './publish/client.js'
import { activePlugins } from './stores/index.js'
import { isBrochurePlugin } from './stores/types.js'
import { createLog, logRejectedItem, type LogFn } from './util/log.js'
import { QuotaExhaustedError } from './util/retry.js'

export type PipelineStage = 'scrape' | 'ocr' | 'publish' | 'done'

export interface PipelineStatus {
  runStartedAt: string
  stage: PipelineStage
  stores: Record<
    string,
    {
      pagesFound: number
      newImages: number
      existingImages: number
      skipped: number
      itemsExtracted: number
      itemsRejected: number
    }
  >
}

export interface PipelineOptions {
  stateDir: string
  /** Default true in PR2 — the ingest URL goes live with PR4. */
  dryRun: boolean
  fetch?: FetchLike
  ocrClient?: GeminiClient
  publishFetch?: PublishFetch
  log?: LogFn
  /** Injectable clock for deterministic scrapedAt in tests. */
  now?: () => Date
}

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly exitCode: number
  ) {
    super(message)
    this.name = 'PipelineError'
  }
}

async function writeStatus(stateDir: string, status: PipelineStatus): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    path.join(stateDir, 'status.json'),
    JSON.stringify(status, null, 2) + '\n',
    'utf8'
  )
}

async function processStore(
  store: StoreConfig,
  config: ScraperConfig,
  options: PipelineOptions,
  scrapedAt: string,
  status: PipelineStatus,
  log: LogFn
): Promise<ImageProducts[]> {
  const entry = status.stores[store.slug]!
  const stateFile = path.join(options.stateDir, store.slug, 'state.json')
  const imagesDir = path.join(
    options.stateDir,
    store.slug,
    'images',
    scrapedAt.slice(0, 10).replace(/-/g, '')
  )

  const plugin = activePlugins(config).find((p) => p.config.slug === store.slug)
  if (!plugin || !isBrochurePlugin(plugin)) {
    throw new PipelineError(`No brochure plugin for ${store.slug}`, 1)
  }

  const fetcher = createFetcher(store, { fetch: options.fetch, log })
  const pages = await plugin.listBrochurePages({
    fetchHtml: (url) => fetcher.fetchHtml(url),
    runStartedAt: scrapedAt,
  })
  entry.pagesFound = pages.length

  const state: ScraperState = await loadState(stateFile)
  const classified = await classifyImages(pages, state, {
    imagesDir,
    minImageSizeKb: config.novelty.minImageSizeKb,
    minDimensionPx: config.novelty.minDimensionPx,
    fetcher,
    log,
  })
  entry.newImages = classified.newImages.length
  entry.existingImages = classified.existingImages.length
  entry.skipped = classified.skipped.length

  const ocr: Ocr = await createOcr({
    model: config.ocr.model,
    storeSlug: store.slug,
    maxRetries: config.ocr.maxRetries + 1,
    client: options.ocrClient,
    log,
  })

  const imageProducts: ImageProducts[] = []
  for (const image of classified.newImages) {
    const bytes = new Uint8Array(await readFile(image.filePath))
    const rawItems = await ocr.ocrImage(bytes)
    const products: ValidatedProduct[] = []
    for (const raw of rawItems) {
      const [product, rejectReason] = validateProduct(raw, image.filename)
      if (product) {
        products.push(product)
      } else {
        entry.itemsRejected++
        await logRejectedItem(options.stateDir, {
          storeSlug: store.slug,
          imageFilename: image.filename,
          name: raw.name ? String(raw.name) : undefined,
          reason: rejectReason!,
        })
      }
    }
    entry.itemsExtracted += products.length
    imageProducts.push({ storeSlug: store.slug, brochureUrl: image.brochureUrl, products })
  }

  // Only mark images processed after their items are safely extracted, so a
  // crashed OCR pass re-processes them on the next run.
  state.processed.push(...classified.newImages)
  state.lastRun = scrapedAt
  await saveState(state, stateFile)

  return imageProducts
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineStatus> {
  const log = options.log ?? createLog('pipeline')
  const config = loadConfig()
  const scrapedAt = (options.now ?? (() => new Date()))().toISOString()
  const status: PipelineStatus = {
    runStartedAt: scrapedAt,
    stage: 'scrape',
    stores: Object.fromEntries(
      config.stores
        .filter((store) => store.slug === 'superindo')
        .map((store) => [
          store.slug,
          {
            pagesFound: 0,
            newImages: 0,
            existingImages: 0,
            skipped: 0,
            itemsExtracted: 0,
            itemsRejected: 0,
          },
        ])
    ),
  }

  try {
    const allImageProducts: ImageProducts[] = []
    for (const store of config.stores.filter((s) => s.slug === 'superindo')) {
      const imageProducts = await processStore(store, config, options, scrapedAt, status, log)
      allImageProducts.push(...imageProducts)
    }

    status.stage = 'publish'
    const payload = buildPayload({
      stores: config.stores,
      images: allImageProducts,
      scrapedAt,
    })
    const result = await publishPayload(payload, {
      stateDir: options.stateDir,
      dryRun: options.dryRun,
      fetch: options.publishFetch,
      log,
    })
    log(
      result.mode === 'dry-run'
        ? `[publish] Dry-run — payload written to ${result.payloadFile}`
        : `[publish] Accepted ${result.response?.accepted ?? 0} items`
    )
    status.stage = 'done'
    return status
  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      throw new PipelineError(error.message, 2)
    }
    if (error instanceof PipelineError) throw error
    throw new PipelineError(String(error), 1)
  } finally {
    await writeStatus(options.stateDir, status).catch(() => {})
  }
}
