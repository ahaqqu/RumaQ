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

/** Launcher whose pages navigate fine but never render the wait anchor. */
function anchorlessLauncher(content: () => Promise<string>): BrowserLauncher {
  return {
    launch: async () => ({
      newPage: async () => ({
        goto: async () => {},
        waitFor: async () => {
          throw new Error('Timeout 30000ms exceeded')
        },
        content,
        close: async () => {},
      }),
      close: async () => {},
    }),
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

  it('a strict anchor wait maps the timeout to FetchTransport (default, no flag)', async () => {
    // The listing wait and every waitForSelector call site without the flag
    // keep today's strictness: an anchor timeout rides the retry ladder and
    // fails the fetch when exhausted.
    const fetcher = createBrowserFetcher(browserStore, {
      launcher: anchorlessLauncher(async () => '<html><body>never read</body></html>'),
      retries: 0,
      backoffMs: 1,
      sleep: async () => {},
    })
    const failure = await Effect.runPromiseExit(
      fetcher.fetchRendered('https://alfagift.id/promo', {
        waitForSelector: 'a[href^="/promo/"]',
      })
    )
    expect(failure._tag).toBe('Failure')
    expect(exitError(failure)).toMatchObject({ _tag: 'FetchTransport' })
    await fetcher.close()
  })

  it('an optional anchor wait reads the DOM as-is instead of failing (issue #360)', async () => {
    // Alfamart teaser/event campaigns (e.g. /promo/UCOllect) hydrate with
    // ZERO product anchors forever — a strict wait kills the store as
    // FetchTransport before the plugin's zero-card warning branch (A4) can
    // decide. With the flag the timeout is swallowed per attempt: logged,
    // then the content is read anyway (one wait, no retry ladder — a
    // swallowed wait never re-enters it).
    const logs: string[] = []
    let waits = 0
    const launcher: BrowserLauncher = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          waitFor: async () => {
            waits++
            throw new Error('Timeout 30000ms exceeded')
          },
          content: async () => '<html><body>teaser shell, zero /p/ anchors</body></html>',
          close: async () => {},
        }),
        close: async () => {},
      }),
    }
    const fetcher = createBrowserFetcher(browserStore, {
      launcher,
      retries: 2,
      backoffMs: 1,
      sleep: async () => {},
      log: (message) => logs.push(message),
    })
    const html = await Effect.runPromise(
      fetcher.fetchRendered('https://alfagift.id/promo/UCOllect', {
        waitForSelector: 'a[href^="/p/"]',
        waitForSelectorOptional: true,
      })
    )
    expect(html).toContain('teaser shell')
    expect(waits).toBe(1)
    expect(
      logs.some(
        (line) =>
          line.includes('anchor "a[href^="/p/"]" did not appear within 30000ms') &&
          // The underlying wait failure is named too — a non-timeout cause
          // must not masquerade as a full-window timeout.
          line.includes('reading the DOM as-is (optional wait): Error: Timeout 30000ms exceeded')
      )
    ).toBe(true)
    await fetcher.close()
  })

  it('an optional anchor wait still escalates challenge content to Tier 3', async () => {
    // The flag only downgrades the anchor timeout — the Incapsula verdict
    // after the content read stays fatal, exactly as on strict waits.
    const interstitial = '<html><script src="/_Incapsula_Resource?SWHDLEDF"></script></html>'
    const fetcher = createBrowserFetcher(browserStore, {
      launcher: anchorlessLauncher(async () => interstitial),
      retries: 2,
      backoffMs: 1,
      challengeSettleMs: 2_000,
      sleep: async () => {},
    })
    const failure = await Effect.runPromiseExit(
      fetcher.fetchRendered('https://alfagift.id/promo/UCOllect', {
        waitForSelector: 'a[href^="/p/"]',
        waitForSelectorOptional: true,
      })
    )
    expect(failure._tag).toBe('Failure')
    expect(exitError(failure)).toMatchObject({ _tag: 'BrowserTierRequired' })
    await fetcher.close()
  })
})
