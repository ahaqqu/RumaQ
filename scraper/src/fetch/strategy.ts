// Fetch strategy ladder (docs/plan/haqita-integration.md §2):
//   Tier 1 — plain fetch with realistic Chrome headers + cookie jar (this file)
//   Tier 2 — headless Chromium via Playwright (PR3, for Lotte/Incapsula)
//   Tier 3 — per-store proxy via env (plumbed here through the `proxy` option)
//
// Port of haqita base_scraper.py DEFAULT_HEADERS + _request_with_retries.
// All failures are typed tagged errors; transport and HTTP-status failures
// are retried by the shared engine, content-type and tier errors are fatal.

import { Data, Effect } from 'effect'

import type { StoreConfig } from '../config.js'
import { isPermanentClientStatus, withRetries } from '../util/retry.js'

export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
}

export class BrowserTierRequired extends Data.TaggedError('BrowserTierRequired')<{
  url: string
  message: string
}> {}

export class FetchTransport extends Data.TaggedError('FetchTransport')<{
  url: string
  cause: unknown
  message: string
}> {}

export class FetchHttpStatus extends Data.TaggedError('FetchHttpStatus')<{
  url: string
  status: number
  statusText: string
  message: string
}> {}

export class NonImageContent extends Data.TaggedError('NonImageContent')<{
  url: string
  contentType: string
  message: string
}> {}

export type FetchError = BrowserTierRequired | FetchTransport | FetchHttpStatus | NonImageContent

export type FetchLike = (url: string, init?: RequestInit & { proxy?: string }) => Promise<Response>

/** A downloaded binary plus the content type the server declared for it. */
export interface DownloadedImage {
  bytes: Uint8Array
  contentType: string | null
}

export interface StoreFetcher {
  fetchHtml(url: string): Effect.Effect<string, FetchError>
  fetchBytes(url: string): Effect.Effect<DownloadedImage, FetchError>
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
  const proxyUrl = options.proxyUrl ?? (store.proxyEnv ? process.env[store.proxyEnv] : undefined)
  const jar: CookieJar = { jars: new Map() }

  const request = (
    url: string,
    accept: string
  ): Effect.Effect<Response, FetchTransport | FetchHttpStatus> => {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS, Accept: accept }
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

  return {
    fetchHtml(url: string): Effect.Effect<string, FetchError> {
      // A store pinned to the browser tier never wastes plain-fetch attempts.
      if (store.strategy === 'browser') {
        return Effect.fail(
          new BrowserTierRequired({
            url,
            message:
              `Plain fetch is not enough for ${url} — Tier-2 (headless browser) lands in PR3 ` +
              '(run scripts/check-lotte.ts from the VPS to confirm the tier decision).',
          })
        )
      }
      return request(url, DEFAULT_HEADERS.Accept).pipe(
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
    },
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
  }
}
