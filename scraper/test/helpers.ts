// Shared test helpers.

import { Cause, Exit } from 'effect'

/** Extract the failed error value from a runPromiseExit result (null on success). */
export function exitError<E>(exit: Exit.Exit<unknown, E>): E | null {
  return Exit.match(exit, {
    onSuccess: () => null,
    onFailure: (cause) => Cause.squash(cause) as E,
  })
}
