// Canonical fs-IO error wrapper. Every module that touches the filesystem
// (novelty state, the publish outbox, the pipeline's per-run items file)
// maps failures the same way: `Effect.tryPromise` around the node:fs call,
// rejections mapped into a tagged error carrying op/path/cause/message.
// `wrapIo(ErrorClass)` builds that wrapper for one tagged error class, so a
// module keeps its own error tag without re-copying the mapping body.

import { Effect } from 'effect'

/** Fields every wrapIo-produced tagged error carries. */
export interface IoErrorArgs {
  op: string
  path: string
  cause: unknown
  message: string
}

/** Constructor of a tagged error class whose fields are exactly IoErrorArgs. */
export type IoErrorClass<E> = new (args: IoErrorArgs) => E

/**
 * Build an fs-IO wrapper for a tagged error class: `const io = wrapIo(StateIo)`
 * yields `io(op, path, run)` — an Effect that runs `run()` and maps any
 * rejection to `new ErrorClass({ op, path: file, cause, message })`.
 */
export function wrapIo<E>(ErrorClass: IoErrorClass<E>) {
  return <A>(op: string, file: string, run: () => Promise<A>): Effect.Effect<A, E> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new ErrorClass({
          op,
          path: file,
          cause,
          message: `${op} ${file} failed: ${String(cause)}`,
        }),
    })
}
