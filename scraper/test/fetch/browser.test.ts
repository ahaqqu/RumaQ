// Tier-2 browser ladder tests — fake launcher, no chromium needed.

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import {
  createBrowserFetcher,
  type BrowserLauncher,
  type BrowserPage,
  type BrowserSession,
} from '../../src/fetch/browser.js'
import { FetchTransport } from '../../src/fetch/errors.js'
import { exitError } from '../helpers.js'
import type { StoreConfig } from '../../src/config.js'

const browserStore: StoreConfig = {
  slug: 'lotte-mart',
  name: 'Lotte Mart',
  kind: 'brochure',
  strategy: 'browser',
  region: 'jakarta',
  maxPages: 40,
}

/** Scripted launcher: each goto either throws (transport) or returns html. */
function scriptedLauncher(script: (string | Error)[]): {
  launcher: BrowserLauncher
  sessions: () => number
  gotos: () => number
  closes: () => number
} {
  let sessions = 0
  let gotoCalls = 0
  let pageCloses = 0
  return {
    launcher: {
      async launch(): Promise<BrowserSession> {
        sessions++
        let call = 0
        return {
          async newPage(): Promise<BrowserPage> {
            return {
              async goto() {
                gotoCalls++
                const step = script[Math.min(call, script.length - 1)]
                call++
                if (step instanceof Error) throw step
              },
              async waitFor() {},
              async content() {
                const step = script[Math.min(call - 1, script.length - 1)]
                return step instanceof Error ? '<html></html>' : step
              },
              async close() {
                pageCloses++
              },
            }
          },
          async close() {},
        }
      },
    },
    sessions: () => sessions,
    gotos: () => gotoCalls,
    closes: () => pageCloses,
  }
}

describe('createBrowserFetcher', () => {
  it('returns rendered content through one lazily-launched session', async () => {
    const { launcher, sessions } = scriptedLauncher(['<html><body>promo listing</body></html>'])
    const fetcher = createBrowserFetcher(browserStore, {
      launcher,
      sleep: async () => {},
    })
    const html = await Effect.runPromise(
      fetcher.fetchHtml('https://www.lottemart.co.id/all-promo-mart')
    )
    expect(html).toContain('promo listing')
    const html2 = await Effect.runPromise(
      fetcher.fetchHtml('https://www.lottemart.co.id/all-promo-mart')
    )
    expect(html2).toContain('promo listing')
    // One session for the whole store run, tabs per request.
    expect(sessions()).toBe(1)
    await fetcher.close()
  })

  it('retries navigation failures as retryable transports', async () => {
    const { launcher } = scriptedLauncher([
      new Error('net::ERR_CONNECTION_RESET'),
      '<html><body>ok</body></html>',
    ])
    const fetcher = createBrowserFetcher(browserStore, {
      launcher,
      retries: 2,
      backoffMs: 1,
      sleep: async () => {},
    })
    const html = await Effect.runPromise(fetcher.fetchHtml('https://www.lottemart.co.id/'))
    expect(html).toContain('ok')
    await fetcher.close()
  })

  it('escalates to Tier 3 when the challenge persists through the settle window', async () => {
    const { launcher, gotos } = scriptedLauncher([
      '<html><script src="/_Incapsula_Resource?SWHDLEDF"></script></html>',
    ])
    const fetcher = createBrowserFetcher(browserStore, {
      launcher,
      retries: 3,
      backoffMs: 1,
      challengeSettleMs: 2_000,
      sleep: async () => {},
    })
    const failure = await Effect.runPromiseExit(fetcher.fetchHtml('https://www.lottemart.co.id/'))
    expect(failure._tag).toBe('Failure')
    expect(exitError(failure)).toMatchObject({ _tag: 'BrowserTierRequired' })
    // The challenge verdict is a Tier-3 decision, not a retry: one navigation
    // even though the settle window polled the page several times.
    expect(gotos()).toBe(1)
    await fetcher.close()
  })

  it('passes an interstitial that self-resolves within the settle window', async () => {
    // The Incapsula challenge JS sets the incap cookies and reloads AFTER
    // domcontentloaded — the first content() read races it. A page that
    // clears by a later poll must be served, not escalated to Tier 3.
    const interstitial = '<html><script src="/_Incapsula_Resource?SWHDLEDF"></script></html>'
    const real = '<html><body>promo listing</body></html>'
    let reads = 0
    const launcher: BrowserLauncher = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          waitFor: async () => {},
          content: async () => {
            reads++
            return reads <= 2 ? interstitial : real
          },
          close: async () => {},
        }),
        close: async () => {},
      }),
    }
    const fetcher = createBrowserFetcher(browserStore, {
      launcher,
      challengeSettleMs: 3_000,
      sleep: async () => {},
    })
    const html = await Effect.runPromise(fetcher.fetchHtml('https://www.lottemart.co.id/'))
    expect(html).toContain('promo listing')
    await fetcher.close()
  })

  it('a full-size page carrying the protection script is NOT a challenge', async () => {
    // Real Lotte pages embed _Incapsula_Resource on every page; only the
    // tiny interstitial is the challenge (bit us in review — marker-only
    // detection flagged every healthy page).
    const bigHealthy =
      '<html><head><script src="/_Incapsula_Resource?SWUDLSDL"></script></head><body>' +
      '<img src="/media/promo/page.jpg">'.repeat(500) +
      '</body></html>'
    const { launcher } = scriptedLauncher([bigHealthy])
    const fetcher = createBrowserFetcher(browserStore, { launcher, sleep: async () => {} })
    const html = await Effect.runPromise(fetcher.fetchHtml('https://www.lottemart.co.id/'))
    expect(html).toContain('promo/page.jpg')
    await fetcher.close()
  })

  it('fails typed after exhausting navigation retries', async () => {
    const { launcher, closes } = scriptedLauncher([new Error('net::ERR_TIMED_OUT')])
    const fetcher = createBrowserFetcher(browserStore, {
      launcher,
      retries: 2,
      backoffMs: 1,
      sleep: async () => {},
    })
    const failure = await Effect.runPromiseExit(fetcher.fetchHtml('https://www.lottemart.co.id/'))
    expect(failure._tag).toBe('Failure')
    expect(exitError(failure)).toMatchObject({ _tag: 'FetchTransport' })
    // The tab is closed on the failure path too — its lifecycle is local to
    // the request that opened it, not the store-end session close.
    expect(closes()).toBe(1)
    await fetcher.close()
  })

  it('close() swallows launcher errors and never fails the run', async () => {
    const launcher: BrowserLauncher = {
      launch: async () => ({
        newPage: async () => {
          throw new Error('no tabs')
        },
        close: async () => {
          throw new Error('close boom')
        },
      }),
    }
    const fetcher = createBrowserFetcher(browserStore, { launcher, sleep: async () => {} })
    // Never launched (fetchHtml not called) — close on an unlaunched session.
    await expect(fetcher.close()).resolves.toBeUndefined()
    // And after a failed launch attempt, close still never throws.
    await Effect.runPromiseExit(fetcher.fetchHtml('https://www.lottemart.co.id/'))
    await expect(fetcher.close()).resolves.toBeUndefined()
  })

  it('a failed page read maps to FetchTransport, not a defect', async () => {
    const launcher: BrowserLauncher = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          waitFor: async () => {},
          content: async () => {
            throw new Error('detached frame')
          },
          close: async () => {},
        }),
        close: async () => {},
      }),
    }
    const fetcher = createBrowserFetcher(browserStore, {
      launcher,
      retries: 0,
      sleep: async () => {},
    })
    const failure = await Effect.runPromiseExit(fetcher.fetchHtml('https://www.lottemart.co.id/'))
    expect(failure._tag).toBe('Failure')
    expect(exitError(failure)).toBeInstanceOf(FetchTransport)
    await fetcher.close()
  })
})
