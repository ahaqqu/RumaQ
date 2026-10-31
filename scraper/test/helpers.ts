// Shared test helpers.

import { Cause, Effect, Exit } from 'effect'

import type { BrowserLauncher, BrowserPage } from '../src/fetch/browser.js'
import type { FetchContext } from '../src/stores/types.js'

/** Extract the failed error value from a runPromiseExit result (null on success). */
export function exitError<E>(exit: Exit.Exit<unknown, E>): E | null {
  return Exit.match(exit, {
    onSuccess: () => null,
    onFailure: (cause) => Cause.squash(cause) as E,
  })
}

/**
 * Completes a store-test FetchContext literal. The pipeline always hands
 * plugins every capability (fetchHtml, fetchRendered, fetchDocument,
 * renderPdf); tests for stores that never touch a capability leave it out,
 * and the dead defaults here die loudly if one ever does — a tripwire
 * against silent capability drift. The warn channel (issue #322, A4) is the
 * one non-dying default: it collects into the returned `warnings` array so
 * a test can assert what the plugin warned about.
 */
export function fullFetchContext(
  base: Pick<FetchContext, 'runStartedAt'> &
    Partial<
      Pick<FetchContext, 'fetchHtml' | 'fetchRendered' | 'fetchDocument' | 'renderPdf' | 'warn'>
    >
): FetchContext & { warnings: string[] } {
  const warnings: string[] = []
  return {
    ...base,
    fetchHtml:
      base.fetchHtml ??
      ((url) => Effect.die(new Error(`unexpected fetchHtml(${url}) in this store test`))),
    fetchRendered:
      base.fetchRendered ??
      ((url) => Effect.die(new Error(`unexpected fetchRendered(${url}) in this store test`))),
    fetchDocument:
      base.fetchDocument ??
      ((url) => Effect.die(new Error(`unexpected fetchDocument(${url}) in this store test`))),
    renderPdf:
      base.renderPdf ?? (() => Effect.die(new Error('unexpected renderPdf in this store test'))),
    warn: base.warn ?? ((message: string) => void warnings.push(message)),
    warnings,
  }
}

/**
 * Fake Tier-2 launcher: every navigation resolves to `html` — or, given a
 * record, to the entry whose key the URL includes (issue #322: the Alfamart
 * pipeline test serves the /promo listing vs /promo/{slug} detail pages).
 * `state` is live — pages counts tabs, closed flips on session close, waits
 * counts waitForSelector calls, and navigations records every goto URL.
 */
export function fakeBrowserLauncher(html: string | Record<string, string>): {
  launcher: BrowserLauncher
  state: { pages: number; closed: boolean; waits: number; navigations: string[] }
} {
  const state = { pages: 0, closed: false, waits: 0, navigations: [] as string[] }
  // The fake page remembers the last navigated URL: content() has no URL
  // context, so the per-URL mapping rides goto.
  let lastUrl = ''
  const htmlFor = (url: string): string => {
    if (typeof html === 'string') return html
    for (const [fragment, pageHtml] of Object.entries(html)) {
      if (url.includes(fragment)) return pageHtml
    }
    return '<html><body></body></html>'
  }
  return {
    state,
    launcher: {
      async launch() {
        return {
          async newPage(): Promise<BrowserPage> {
            state.pages++
            return {
              async goto(url: string) {
                lastUrl = url
                state.navigations.push(url)
              },
              async waitFor(selector: string) {
                state.waits++
                if (selector === '__never__') throw new Error('waitFor timeout')
              },
              async content() {
                return htmlFor(lastUrl)
              },
              async close() {},
            }
          },
          async close() {
            state.closed = true
          },
        }
      },
    },
  }
}
