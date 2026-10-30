// Shared test helpers.

import { Cause, Effect, Exit } from 'effect'

import type { BrowserLauncher } from '../src/fetch/browser.js'
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
 * plugins every capability (fetchHtml, fetchDocument, renderPdf); tests for
 * stores that never touch documents (everything except Indomaret) leave
 * them out, and the dead defaults here die loudly if one ever does — a
 * tripwire against silent capability drift.
 */
export function fullFetchContext(
  base: Pick<FetchContext, 'fetchHtml' | 'runStartedAt'> &
    Partial<Pick<FetchContext, 'fetchDocument' | 'renderPdf'>>
): FetchContext {
  return {
    ...base,
    fetchDocument:
      base.fetchDocument ??
      ((url) => Effect.die(new Error(`unexpected fetchDocument(${url}) in this store's test`))),
    renderPdf:
      base.renderPdf ?? (() => Effect.die(new Error('unexpected renderPdf in this store test'))),
  }
}

/**
 * Fake Tier-2 launcher: every navigation resolves to `html`. `state` is
 * live — pages counts tabs, closed flips on session close.
 */
export function fakeBrowserLauncher(html: string): {
  launcher: BrowserLauncher
  state: { pages: number; closed: boolean }
} {
  const state = { pages: 0, closed: false }
  return {
    state,
    launcher: {
      async launch() {
        return {
          async newPage() {
            state.pages++
            return {
              async goto() {},
              async content() {
                return html
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
