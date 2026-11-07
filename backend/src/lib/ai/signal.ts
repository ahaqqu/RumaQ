// The door's per-call deadline (plan §5.2). The capability defaults live in the
// facade; this module only composes the caller's signal with a timeout into ONE
// AbortSignal the adapter hands to fetch.
//
// `AbortSignal.timeout` is available on both runtimes we target (Workers and
// Node ≥17.3). `AbortSignal.any` is newer (Node ≥20.3), so it is used when
// present and a two-listener shim stands in otherwise — the plan's requirement.

export type TimeoutSignal = {
  signal: AbortSignal
  /** True once OUR deadline fired (a caller cancellation is not a timeout). */
  timedOut: () => boolean
  /** Remove the shim's listeners; the deadline itself is runtime-managed. */
  dispose: () => void
}

export function withTimeout(caller: AbortSignal | undefined, timeoutMs: number): TimeoutSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  const timedOut = () => deadline.aborted

  if (!caller) {
    return { signal: deadline, timedOut, dispose: () => {} }
  }

  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([caller, deadline]), timedOut, dispose: () => {} }
  }

  const controller = new AbortController()
  const abort = (reason?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const onCallerAbort = (): void => abort(caller.reason)
  const onDeadline = (): void => abort(deadline.reason)
  if (caller.aborted) abort(caller.reason)
  else caller.addEventListener('abort', onCallerAbort, { once: true })
  deadline.addEventListener('abort', onDeadline, { once: true })

  return {
    signal: controller.signal,
    timedOut,
    dispose: () => caller.removeEventListener('abort', onCallerAbort),
  }
}
