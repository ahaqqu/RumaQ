// StorePlugin interface — every store is pluggable (docs/plan/haqita-integration.md §1).
// Two capabilities, matching how a store publishes promos:
// - brochure: image pages that need OCR (Superindo, Lotte)
// - catalog:  structured items fetched directly (Astro; Alfamart/Indomaret future)
//
// All plugin entry points are Effects: failures surface as typed tagged
// errors (FetchError from the strategy ladder) instead of exceptions.

import type { StoreConfig } from '../config.js'
import type { RenderedFetchOptions } from '../fetch/browser.js'
import type { FetchError, PdfRenderError } from '../fetch/errors.js'
import type { DownloadedImage } from '../fetch/strategy.js'
import type { RenderedPage } from '../util/pdf.js'
import type { Effect } from 'effect'

/** A single brochure page image to download and OCR. */
export interface BrochurePage {
  /** Absolute image URL to download. */
  imageUrl: string
  /** Deep-link back to the store's original brochure page (stored on observations). */
  brochureUrl: string
  /**
   * Pre-fetched page bytes (issue #322, design-arch §1.2): Indomaret's
   * rendered PDF pages arrive already downloaded, so classifyImages skips
   * the download and keys novelty on these bytes. Undefined = download
   * imageUrl as before — every store except Indomaret, byte-for-byte.
   */
  bytes?: Uint8Array
  /**
   * Filename for the page (R2 object key segment). Defaults to the
   * imageUrl's basename — always md5-prefixed by classifyImages, so a
   * rendered-page name (`…-page-01.png`) never collides across runs.
   */
  filename?: string
}

export interface FetchContext {
  /** Fetch a document through the store's strategy ladder (§2). */
  fetchHtml(url: string): Effect.Effect<string, FetchError>
  /**
   * Rendered-DOM fetch with an optional waitForSelector anchor (issue #322,
   * design-arch §2.2 — Alfamart). The plain tier aliases it to fetchHtml:
   * nothing to wait for on Tier 1. `waitForSelectorOptional` (issue #360)
   * downgrades an anchor timeout to a logged note — the DOM is read as-is
   * (teaser campaigns never render the anchor).
   */
  fetchRendered(url: string, opts?: RenderedFetchOptions): Effect.Effect<string, FetchError>
  /**
   * Raw-byte fetch with no image content gate (issue #322): a document
   * fetch (Indomaret's brochure PDFs) is honest about being non-image.
   */
  fetchDocument(url: string): Effect.Effect<DownloadedImage, FetchError>
  /**
   * PDF → page-image renderer (issue #322). Only stores that rasterize
   * documents call it; the pipeline injects util/pdf.ts's pdftoppm
   * renderer (or a test fake via PipelineOptions.renderPdf).
   */
  renderPdf(
    pdf: Uint8Array,
    opts?: { maxPages?: number }
  ): Effect.Effect<RenderedPage[], PdfRenderError>
  /**
   * Record a non-fatal anomaly for this store's run (issue #322, A4): an
   * empty campaign/brochure page that the churn sentinel must NOT fire on
   * by itself (a scheduled teaser page is a plausible non-churn state).
   * The pipeline collects these into status.json and the run report with
   * the offending URL, while the cycle continues. Structural churn is
   * still the sentinel's job — the plugin fails ScrapeStructureError when
   * the churn signature (≥ half the visited pages yielded nothing, or an
   * empty listing) appears.
   */
  warn(message: string): void
  /** RFC-3331 timestamp of the current run (shared by all stages). */
  runStartedAt: string
}

export interface BrochureStorePlugin {
  config: StoreConfig
  listBrochurePages(ctx: FetchContext): Effect.Effect<BrochurePage[], FetchError>
}

export interface CatalogStorePlugin {
  config: StoreConfig
  listItems(ctx: FetchContext): Effect.Effect<CatalogItem[], FetchError>
}

/** Structured item from a catalog-style source — already OCR-free. */
export interface CatalogItem {
  name: string
  brand?: string | null
  unit?: string | null
  price: number
  /** Promo labels as separate strings; the payload builder joins them for display. */
  promoLabels?: string[] | null
  validFrom?: string | null
  validUntil?: string | null
  pageUrl?: string | null
}

export type StorePlugin = BrochureStorePlugin | CatalogStorePlugin

export function isCatalogPlugin(plugin: StorePlugin): plugin is CatalogStorePlugin {
  return plugin.config.kind === 'catalog'
}
