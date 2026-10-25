// Fetch strategy ladder (docs/plan/haqita-integration.md §2):
//   Tier 1 — plain fetch with realistic Chrome headers + cookie jar (this file)
//   Tier 2 — headless Chromium via Playwright (PR3, for Lotte/Incapsula)
//   Tier 3 — per-store proxy via env (plumbed here through the `proxy` option)
//
// Port of haqita base_scraper.py DEFAULT_HEADERS + _request_with_retries.

import type { StoreConfig } from '../config.js'
import { withRetries } from '../util/retry.js'

export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
}

export class BrowserTierRequiredError extends Error {
  constructor(url: string) {
    super(
      `Plain fetch is not enough for ${url} — Tier-2 (headless browser) lands in PR3 ` +
        '(run scripts/check-lotte.ts from the VPS to confirm the tier decision).'
    )
    this.name = 'BrowserTierRequiredError'
  }
}

export type FetchLike = (url: string, init?: RequestInit & { proxy?: string }) => Promise<Response>

export interface StoreFetcher {
  fetchHtml(url: string): Promise<string>
  fetchBytes(url: string): Promise<Uint8Array>
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

async function requestWithRetries(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit & { proxy?: string },
  opts: {
    retries: number
    backoffMs: number
    sleep: (ms: number) => Promise<void>
    log: (message: string) => void
  }
): Promise<Response> {
  return withRetries(
    async () => {
      const response = await fetchFn(url, init)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
      }
      return response
    },
    {
      retries: opts.retries,
      backoffMs: opts.backoffMs,
      sleep: opts.sleep,
      log: opts.log,
      context: `fetch ${url}`,
    }
  )
}

export interface CreateFetcherOptions {
  fetch?: FetchLike
  retries?: number
  backoffMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  /** Tier-3 override; defaults to the store's proxyEnv value. */
  proxyUrl?: string
}

export function createFetcher(
  store: StoreConfig,
  options: CreateFetcherOptions = {}
): StoreFetcher {
  const fetchFn = options.fetch ?? fetch
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 2000
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})
  const proxyUrl = options.proxyUrl ?? (store.proxyEnv ? process.env[store.proxyEnv] : undefined)
  const jar: CookieJar = { jars: new Map() }

  const request = (url: string, accept: string) => {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS, Accept: accept }
    const cookie = jarCookieHeader(jar, url)
    if (cookie) headers.Cookie = cookie
    const init: RequestInit & { proxy?: string } = { headers, redirect: 'follow' }
    if (proxyUrl) init.proxy = proxyUrl
    return requestWithRetries(fetchFn, url, init, { retries, backoffMs, sleep, log }).then(
      (response) => {
        storeCookies(jar, url, response)
        return response
      }
    )
  }

  return {
    async fetchHtml(url: string): Promise<string> {
      // A store pinned to the browser tier never wastes plain-fetch attempts.
      if (store.strategy === 'browser') throw new BrowserTierRequiredError(url)
      const response = await request(url, DEFAULT_HEADERS.Accept)
      return response.text()
    },
    async fetchBytes(url: string): Promise<Uint8Array> {
      const response = await request(url, '*/*')
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}
