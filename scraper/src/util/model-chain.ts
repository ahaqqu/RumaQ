// Gemini model fallback chain (issue #347) — one home for chain parsing,
// per-run rung state, and the fallback loop. The chain lives OUTSIDE
// `withQuotaPolicy`: each rung gets its full transient ladder, and only an
// error that escaped the ladder reaches the advance classification
// (QuotaExhausted / isSaturationError / isModelFatalError). A per-minute 429,
// a generic 5xx, or any other failure is never a rung trigger — it propagates
// unchanged, exactly as before the chain existed. The state is a per-run
// object (quota is key-scoped across stores), created by the pipeline and
// threaded through as `string | ModelChainState`, so rung advances propagate
// across images and stores automatically. No client is rebuilt: the model id
// is read fresh per call via `current()`.

import { Effect } from 'effect'

import { isModelFatalError, isSaturationError, QuotaExhausted } from './retry.js'

/**
 * Parse the effective model chain from the env pair. Precedence:
 * CHAIN var (wholesale ordered override) > scalar var (chain of one — an
 * explicit pin means pin, failover off) > the shipped default chain. Blank,
 * whitespace, or comma-only values count as unset (mirrors storeProxyUrl);
 * a CHAIN var that parses to zero models is unset, not an error — zero-rung
 * chains are unrepresentable. No dedupe — the list is taken verbatim.
 */
export function parseModelChain(
  chainEnv: string | undefined,
  scalarEnv: string | undefined,
  fallback: readonly string[]
): string[] {
  const chain = (chainEnv ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (chain.length > 0) return chain
  const scalar = scalarEnv?.trim()
  if (scalar) return [scalar]
  return [...fallback]
}

/** One dead rung, recorded at advance time for the exhaustion enumeration. */
export interface RungDeath {
  readonly model: string
  readonly reason: string
}

export interface ModelChainState {
  /** The full rung list, in order — the head is the quality pin. */
  readonly chain: readonly string[]
  /** Rungs advanced away from so far, in death order (testable audit). */
  readonly deaths: readonly RungDeath[]
  /** True once every rung has been advanced away from. */
  readonly exhausted: boolean
  /** The rung the next call uses (the last one once exhausted). */
  current(): string
  /**
   * Mark the current rung dead and move to the next. Returns false when no
   * rung remains (the chain is then exhausted); the last error must be
   * rethrown unchanged by the caller, never masked.
   */
  advance(reason: string, log?: (message: string) => void): boolean
}

export function createModelChain(chain: readonly string[], label?: string): ModelChainState {
  // Zero-rung chains are unrepresentable (parseModelChain never yields one);
  // a hand-built empty chain is a programming error, not a runtime state.
  if (chain.length === 0) throw new Error('model chain must have at least one rung')
  const models = [...chain]
  const prefix = label ? ` ${label}` : ''
  let index = 0
  const deaths: RungDeath[] = []
  return {
    chain: models,
    deaths,
    get exhausted(): boolean {
      return index >= models.length
    },
    current(): string {
      return models[Math.min(index, models.length - 1)]!
    },
    advance(reason, log) {
      if (index >= models.length) return false
      const dead = models[index]!
      deaths.push({ model: dead, reason })
      index += 1
      if (index < models.length) {
        log?.(`[chain]${prefix} rung advanced: ${dead} → ${models[index]} (${reason})`)
        return true
      }
      log?.(`[chain]${prefix} all ${models.length} rungs exhausted (${reason})`)
      return false
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The advance vocabulary (design C2): the only reasons a rung ever dies.
 * Classification runs on the ladder-escaped error — text-based classifiers
 * see through the typed call-site wrappers verbatim.
 */
function advanceReason(error: unknown): string | null {
  if (error instanceof QuotaExhausted) return 'daily-quota 429'
  if (isSaturationError(error)) return '503 saturation after ladder'
  if (isModelFatalError(error)) {
    return errorText(error).includes('404') ? 'model-fatal 404' : 'model-fatal 400'
  }
  return null
}

/**
 * Run `rung` with model failover. A plain `string` is a pass-through
 * (chain-of-one, existing call sites and tests unchanged); a
 * `ModelChainState` loops: read `current()` fresh per attempt, and on a
 * ladder-escaped advance-trigger error advance to the next rung and rebuild
 * the effect with the new model — no inter-rung sleeps, no client rebuild.
 * Anything else (per-minute 429s, other transients, payload errors) — or a
 * rung death with no rung left — rethrows the error UNCHANGED, so every
 * existing handler (per-store isolation, exit-code mapping, verifier
 * catchTag) keeps working untouched.
 */
export function withModelFallback<A, E>(
  model: string | ModelChainState,
  rung: (model: string) => Effect.Effect<A, E>,
  log?: (message: string) => void
): Effect.Effect<A, E> {
  if (typeof model === 'string') return rung(model)
  const loop = (): Effect.Effect<A, E> =>
    Effect.suspend(() =>
      rung(model.current()).pipe(
        Effect.catchIf(
          () => true,
          (error) => {
            const reason = advanceReason(error)
            if (reason === null) return Effect.fail(error)
            return Effect.sync(() => model.advance(reason, log)).pipe(
              Effect.flatMap((advanced) => (advanced ? loop() : Effect.fail(error)))
            )
          }
        )
      )
    )
  return loop()
}
