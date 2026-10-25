// Shared test helpers.

import { Cause, Exit } from 'effect'

import type { BrowserLauncher } from '../src/fetch/browser.js'

/** Extract the failed error value from a runPromiseExit result (null on success). */
export function exitError<E>(exit: Exit.Exit<unknown, E>): E | null {
  return Exit.match(exit, {
    onSuccess: () => null,
    onFailure: (cause) => Cause.squash(cause) as E,
  })
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
