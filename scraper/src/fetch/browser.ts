// Tier 2 — headless Chromium via Playwright (docs/plan/haqita-integration.md
// §2): Lotte sits behind Imperva Incapsula, and a real browser executing the
// challenge usually passes regardless of datacenter IP. The browser seam is
// an injectable launcher so tests run with a fake and the playwright-core
// import stays lazy — the plain-tier Superindo path never loads it, and the
// test suite needs no chromium install.

import { Effect } from 'effect'

import type { StoreConfig } from '../config.js'
import { isPermanentClientStatus, withRetries } from '../util/retry.js'
import { BrowserTierRequired, FetchError, FetchHttpStatus, FetchTransport } from './errors.js'

/** One browser tab: navigate, read rendered content. */
export interface BrowserPage {
  goto(url: string, timeoutMs: number): Promise<void>
  content(): Promise<string>
  close(): Promise<void>
}

/** One browser session (multi-tab); closed when the store's run ends. */
export interface BrowserSession {
  newPage(): Promise<BrowserPage>
  close(): Promise<void>
}

export interface BrowserLauncher {
  launch(): Promise<BrowserSession>
}

export interface BrowserFetcherOptions {
  retries?: number
  backoffMs?: number
  /** Per-navigation timeout; a stalled challenge becomes a retryable error. */
  timeoutMs?: number
  /**
   * Bounded window an Incapsula interstitial gets to self-resolve (its JS
   * sets the incap cookies and reloads after domcontentloaded) before the
   * verdict escalates to BrowserTierRequired. Injectable for tests.
   */
  challengeSettleMs?: number
  launcher?: BrowserLauncher
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

// Incapsula fingerprints (same markers as scripts/check-lotte.ts) — with a
// size gate: real Lotte pages carry the protection script too, so marker
// presence alone would flag every healthy page. The interstitial challenge
// is tiny; a rendered listing page is hundreds of KB. If the browser tier
// still gets the challenge after the settle window below, no retry helps —
// the store needs Tier 3.
const CHALLENGE_MAX_HTML_BYTES = 10_000

/** How often the settle window re-reads the page while waiting. */
const CHALLENGE_POLL_INTERVAL_MS = 1_000

function looksLikeIncapsulaChallenge(html: string): boolean {
  if (html.length >= CHALLENGE_MAX_HTML_BYTES) return false
  return html.includes('_Incapsula_Resource') || /visid_incap_|incap_ses_|___utmvc/.test(html)
}

/**
 * The real launcher — playwright-core's chromium with a realistic context.
 * `playwright-core` is imported lazily: a Superindo-only run (or the test
 * suite) must not pay for it, and the VPS bundle keeps it external.
 */
export function playwrightLauncher(
  options: {
    proxyUrl?: string
    executablePath?: string
  } = {}
): BrowserLauncher {
  return {
    async launch(): Promise<BrowserSession> {
      const { chromium } = await import('playwright-core')
      const browser = await chromium.launch({
        headless: true,
        // /dev/shm is tiny on the VPS; Chromium crashes without this.
        args: ['--disable-dev-shm-usage'],
        ...(options.proxyUrl ? { proxy: { server: options.proxyUrl } } : {}),
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      })
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'id-ID',
      })
      return {
        async newPage(): Promise<BrowserPage> {
          const page = await context.newPage()
          return {
            async goto(url: string, timeoutMs: number): Promise<void> {
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
            },
            async content(): Promise<string> {
              return page.content()
            },
            async close(): Promise<void> {
              await page.close()
            },
          }
        },
        async close(): Promise<void> {
          await context.close()
          await browser.close()
        },
      }
    },
  }
}

export interface BrowserFetcher {
  fetchHtml(url: string): Effect.Effect<string, FetchError>
  /** Closes the browser session if one was launched; never throws. */
  close(): Promise<void>
}

/**
 * Browser-tier HTML fetcher: lazily launches one session per store run,
 * one tab per request, retries transport/status failures, and fails fast
 * when the browser tier itself is served an Incapsula challenge (that is a
 * Tier-3 proxy decision, not a retry).
 */
export function createBrowserFetcher(
  store: StoreConfig,
  options: BrowserFetcherOptions = {}
): BrowserFetcher {
  const retries = options.retries ?? 2
  const backoffMs = options.backoffMs ?? 2000
  const timeoutMs = options.timeoutMs ?? 30_000
  const challengeSettleMs = options.challengeSettleMs ?? 8_000
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})
  const launcher =
    options.launcher ??
    playwrightLauncher({ proxyUrl: store.proxyEnv ? process.env[store.proxyEnv] : undefined })

  let session: BrowserSession | undefined
  const ensureSession = async (): Promise<BrowserSession> => {
    if (!session) {
      log(`[browser] launching chromium for ${store.slug}`)
      session = await launcher.launch()
    }
    return session
  }

  return {
    fetchHtml(url: string): Effect.Effect<string, FetchError> {
      return Effect.gen(function* () {
        const active = yield* Effect.tryPromise({
          try: () => ensureSession(),
          catch: (cause: unknown) =>
            new FetchTransport({
              url,
              cause,
              message: `Browser launch failed for ${store.slug}: ${String(cause)}`,
            }),
        })
        const page = yield* Effect.tryPromise({
          try: () => active.newPage(),
          catch: (cause: unknown) =>
            new FetchTransport({
              url,
              cause,
              message: `New page failed for ${url}: ${String(cause)}`,
            }),
        })
        const readContent = (): Effect.Effect<string, FetchTransport> =>
          Effect.tryPromise({
            try: () => page.content(),
            catch: (cause: unknown) =>
              new FetchTransport({
                url,
                cause,
                message: `Content read failed for ${url}: ${String(cause)}`,
              }),
          })
        // Wait out an Incapsula interstitial that is still resolving: the
        // challenge's own JS sets the incap cookies and triggers a reload
        // AFTER domcontentloaded, so the first content() read can race it.
        // Poll until the markers clear or the settle window closes — the
        // caller then re-checks and escalates to Tier 3 only if the
        // challenge persists.
        const settleChallenge = (initial: string): Effect.Effect<string, FetchTransport> =>
          Effect.gen(function* () {
            let html = initial
            for (let waited = 0; waited < challengeSettleMs; waited += CHALLENGE_POLL_INTERVAL_MS) {
              yield* Effect.promise(() => sleep(CHALLENGE_POLL_INTERVAL_MS))
              html = yield* readContent()
              if (!looksLikeIncapsulaChallenge(html)) return html
            }
            return html
          })
        const html = yield* withRetries(
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => page.goto(url, timeoutMs),
              catch: (cause: unknown) =>
                new FetchTransport({
                  url,
                  cause,
                  message: `Navigation failed for ${url}: ${String(cause)}`,
                }),
            })
            let response = yield* readContent()
            if (looksLikeIncapsulaChallenge(response)) {
              log(
                `[browser ${url}] Incapsula interstitial — waiting up to ` +
                  `${challengeSettleMs}ms for the challenge to self-resolve`
              )
              response = yield* settleChallenge(response)
            }
            if (looksLikeIncapsulaChallenge(response)) {
              return yield* new BrowserTierRequired({
                url,
                message:
                  `Browser tier still served an Incapsula challenge for ${url} ` +
                  `(waited ${challengeSettleMs}ms for self-resolution) — ` +
                  'Tier 3 (per-store proxy) is required for this egress IP',
              })
            }
            return response
          }),
          {
            retries,
            backoffMs,
            sleep,
            log,
            context: `browser ${url}`,
            isFatal: (error) =>
              error instanceof BrowserTierRequired ||
              (error instanceof FetchHttpStatus && isPermanentClientStatus(error.status)),
          }
        ).pipe(
          // The tab's lifecycle is local to this request: close it whatever
          // the outcome (success, retries exhausted, or the fatal challenge
          // verdict) — the session close at store end stays as the backstop.
          Effect.onExit(() => Effect.promise(() => page.close().catch(() => undefined)))
        )
        return html
      })
    },
    async close(): Promise<void> {
      try {
        await session?.close()
      } catch {
        // A close failure must never fail an already-completed store run.
      } finally {
        session = undefined
      }
    },
  }
}
