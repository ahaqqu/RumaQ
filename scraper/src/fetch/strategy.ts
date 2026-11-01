// Fetch strategy ladder (docs/plan/haqita-integration.md §2):
//   Tier 1 — plain fetch with realistic Chrome headers + cookie jar (this file)
//   Tier 2 — headless Chromium via Playwright (browser.ts, for Lotte/Incapsula)
//   Tier 3 — per-store proxy via env (plumbed through the `proxy` option)
//
// `createStoreFetcher` at the bottom of this file is the ladder's dispatch:
// plain stores get the Tier-1 fetcher, browser stores get Tier-2 HTML with
// Tier-1 image downloads (the brochure CDN is not challenge-protected).
//
// Port of haqita base_scraper.py DEFAULT_HEADERS + _request_with_retries,
// plus haqita's per-store HEADERS overrides (config headerOverrides).
// All failures are typed tagged errors; transport and HTTP-status failures
// are retried by the shared engine, content-type and tier errors are fatal.

import { Effect } from 'effect'

import type { StoreConfig } from '../config.js'
import { storeProxyUrl } from '../config.js'
import { isPermanentClientStatus, withRetries } from '../util/retry.js'
import { createBrowserFetcher, type BrowserLauncher, type RenderedFetchOptions } from './browser.js'
import {
  type FetchError,
  FetchHttpStatus,
  FetchTransport,
  NonImageContent,
  NotPdfContent,
} from './errors.js'

export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
}

export type FetchLike = (url: string, init?: RequestInit & { proxy?: string }) => Promise<Response>

/** A downloaded binary plus the content type the server declared for it. */
export interface DownloadedImage {
  bytes: Uint8Array
  contentType: string | null
}

export interface StoreFetcher {
  fetchHtml(url: string): Effect.Effect<string, FetchError>
  /**
   * Rendered-DOM fetch with an optional waitForSelector anchor (issue #322,
   * design-arch §2.2 — Alfamart). The plain tier aliases it to fetchHtml:
   * nothing to wait for on Tier 1. The browser tier waits for the anchor
   * inside the navigation's retry engine; `waitForSelectorOptional` (issue
   * #360) downgrades an anchor timeout to a logged note — the DOM is read
   * as-is (teaser campaigns never render the anchor).
   */
  fetchRendered(url: string, opts?: RenderedFetchOptions): Effect.Effect<string, FetchError>
  fetchBytes(url: string): Effect.Effect<DownloadedImage, FetchError>
  /**
   * Raw-byte fetch with NO NonImageContent gate (issue #322, design-arch
   * §1.2): a document fetch (Indomaret's brochure PDFs) is honest about
   * being non-image — the gate exists to protect the OCR download path, not
   * the document path. Same request/retry/cookie-jar machinery as above.
   */
  fetchDocument(url: string): Effect.Effect<DownloadedImage, FetchError>
  /** Releases tier resources (closes the browser session); never throws. */
  close(): Promise<void>
}

interface CookieJar {
  /** host → (cookie name → value) */
  jars: Map<string, Map<string, string>>
}

function jarCookieHeader(jar: CookieJar, url: string): string | undefined {
  try {
    const host = new URL(url).hostname
    const cookies = jar.jars.get(host)
    if (!cookies || cookies.size === 0) return undefined
    return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  } catch {
    return undefined
  }
}

function storeCookies(jar: CookieJar, url: string, response: Response): void {
  const setCookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  if (setCookies.length === 0) return
  try {
    const host = new URL(url).hostname
    let cookies = jar.jars.get(host)
    if (!cookies) {
      cookies = new Map()
      jar.jars.set(host, cookies)
    }
    for (const raw of setCookies) {
      const [pair] = raw.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  } catch {
    // Malformed URL — nothing to persist.
  }
}

function isImageContentType(contentType: string): boolean {
  const mimeType = contentType.split(';')[0]!.trim().toLowerCase()
  return mimeType.startsWith('image/') || mimeType === 'application/octet-stream'
}

/** The PDF format's own marker — the check pdftoppm's input implies. */
function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  )
}

/** First bytes as hex for the failure message — names what was received. */
function leadingBytesHex(bytes: Uint8Array, count = 8): string {
  return [...bytes.slice(0, count)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
}

export interface CreateFetcherOptions {
  fetch?: FetchLike
  retries?: number
  backoffMs?: number
  /** Per-attempt request timeout; a stalled peer becomes a retryable FetchTransport. */
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  /** Tier-3 override; defaults to the store's proxyEnv value. */
  proxyUrl?: string
}

/** Default per-attempt timeout for page/image fetches (C5: no hung daily job). */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000

export function createFetcher(
  store: StoreConfig,
  options: CreateFetcherOptions = {}
): StoreFetcher {
  const fetchFn = options.fetch ?? fetch
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 2000
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})
  const proxyUrl = options.proxyUrl ?? storeProxyUrl(store)
  const jar: CookieJar = { jars: new Map() }
  const request = (
    url: string,
    accept: string
  ): Effect.Effect<Response, FetchTransport | FetchHttpStatus> => {
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...store.headerOverrides,
      Accept: accept,
    }
    const cookie = jarCookieHeader(jar, url)
    if (cookie) headers.Cookie = cookie
    const init: RequestInit & { proxy?: string } = { headers, redirect: 'follow' }
    if (proxyUrl) init.proxy = proxyUrl
    return Effect.tryPromise({
      // The signal is created inside the attempt body so every retry gets a
      // fresh timeout window — an already-aborted shared signal would fail
      // every later attempt instantly. An abort lands in `catch`, i.e. a
      // retryable FetchTransport, never a defect.
      try: () => fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
      catch: (cause) =>
        new FetchTransport({ url, cause, message: `Fetch failed for ${url}: ${String(cause)}` }),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.succeed(response)
          : Effect.fail(
              new FetchHttpStatus({
                url,
                status: response.status,
                statusText: response.statusText,
                message: `HTTP ${response.status} ${response.statusText} for ${url}`,
              })
            )
      ),
      (effect) =>
        withRetries(effect, {
          retries,
          backoffMs,
          sleep,
          log,
          context: `fetch ${url}`,
          // Permanent client errors never succeed on retry; transient ones
          // (429 backoff signal, 408 request timeout, 425 too early) stay
          // retryable. Transport errors stay retryable.
          isFatal: (error) =>
            error instanceof FetchHttpStatus && isPermanentClientStatus(error.status),
        }),
      Effect.tap((response) => Effect.sync(() => storeCookies(jar, url, response)))
    )
  }

  const fetchHtmlEffect = (url: string): Effect.Effect<string, FetchError> =>
    request(url, DEFAULT_HEADERS.Accept).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.text(),
          catch: (cause: unknown) =>
            new FetchTransport({
              url,
              cause,
              message: `Body read failed for ${url}: ${String(cause)}`,
            }),
        })
      )
    )

  return {
    fetchHtml: fetchHtmlEffect,
    // Tier 1 renders nothing — the wait capability is a browser-tier
    // concept, aliased away here (design-arch §2.2). The waitForSelector
    // option is deliberately ignored: a plain GET has nothing to wait for.
    fetchRendered: (url) => fetchHtmlEffect(url),
    fetchBytes(url: string): Effect.Effect<DownloadedImage, FetchError> {
      return request(url, '*/*').pipe(
        Effect.flatMap(
          (response): Effect.Effect<DownloadedImage, NonImageContent | FetchTransport> => {
            // Scraped image hrefs are external input: a body served as HTML
            // (or anything clearly not an image) must never reach the OCR
            // bytes. An absent header or a generic octet-stream passes — CDNs
            // often omit it. Fatal by construction: wrong content never
            // succeeds on retry.
            const contentType = response.headers.get('content-type')
            if (contentType && !isImageContentType(contentType)) {
              return Effect.fail(
                new NonImageContent({
                  url,
                  contentType,
                  message: `Non-image content-type "${contentType}" for ${url}`,
                })
              )
            }
            return Effect.tryPromise({
              try: async () => ({
                bytes: new Uint8Array(await response.arrayBuffer()),
                contentType,
              }),
              catch: (cause: unknown) =>
                new FetchTransport({
                  url,
                  cause,
                  message: `Body read failed for ${url}: ${String(cause)}`,
                }),
            })
          }
        )
      )
    },
    fetchDocument(url: string): Effect.Effect<DownloadedImage, FetchError> {
      // application/pdf is just another content type here: no image gate —
      // fetchBytes' NonImageContent guard must not reject a document fetch.
      return request(url, 'application/pdf,*/*').pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: async () => ({
              bytes: new Uint8Array(await response.arrayBuffer()),
              contentType: response.headers.get('content-type'),
            }),
            catch: (cause: unknown) =>
              new FetchTransport({
                url,
                cause,
                message: `Body read failed for ${url}: ${String(cause)}`,
              }),
          })
        ),
        // Magic-byte sanity (design-arch §1.2): these bytes flow straight to
        // pdftoppm, and a 200 HTML challenge page served for the PDF URL
        // (Cloudflare fronts indomaret.co.id) would otherwise surface as a
        // misleading poppler "Syntax Error". The leading %PDF marker is
        // checked on the bytes, not the declared header, so a real PDF with
        // a wrong content-type still renders; anything else fails typed,
        // naming what was actually received. Fatal by construction: wrong
        // content never succeeds on retry.
        Effect.flatMap((downloaded) => {
          if (isPdfBytes(downloaded.bytes)) return Effect.succeed(downloaded)
          return Effect.fail(
            new NotPdfContent({
              url,
              contentType: downloaded.contentType,
              message:
                `Not a PDF: ${url} served ` +
                `${downloaded.contentType ?? 'no content-type'} ` +
                `(leading bytes: ${leadingBytesHex(downloaded.bytes)})`,
            })
          )
        })
      )
    },
    async close(): Promise<void> {
      // The plain tier holds no resources.
    },
  }
}

export interface CreateStoreFetcherOptions extends CreateFetcherOptions {
  /** Tier-2 launcher; defaults to real Playwright (lazy import inside). */
  launcher?: BrowserLauncher
}

/**
 * The fetch ladder's dispatch (§2): a plain store gets Tier 1 for everything;
 * a browser store gets Tier-2 HTML (the challenge-protected listing page)
 * with Tier-1 image downloads — the brochure CDN is not protected. Callers
 * MUST `close()` the returned fetcher when the store's run ends so the
 * browser session never outlives the pipeline.
 */
export function createStoreFetcher(
  store: StoreConfig,
  options: CreateStoreFetcherOptions = {}
): StoreFetcher {
  if (store.strategy === 'browser') {
    const browser = createBrowserFetcher(store, {
      retries: options.retries,
      backoffMs: options.backoffMs,
      timeoutMs: options.timeoutMs,
      launcher: options.launcher,
      sleep: options.sleep,
      log: options.log,
    })
    // Image bytes ride the plain tier with the store's own cookie jar.
    const plain = createFetcher(store, options)
    return {
      fetchHtml: (url) => browser.fetchHtml(url),
      fetchRendered: (url, opts) => browser.fetchRendered(url, opts),
      fetchBytes: (url) => plain.fetchBytes(url),
      // Document fetches ride the plain tier too (no browser store calls it
      // today; the gate-free bytes path is a plain-tier capability).
      fetchDocument: (url) => plain.fetchDocument(url),
      close: async () => {
        await browser.close()
        await plain.close()
      },
    }
  }
  return createFetcher(store, options)
}
