// AI verifier (gate 6) — port of haqita matcher.py AI_PROMPT_TEMPLATE +
// _verify_one_pair/_gemini_verify. Ambiguous embedding matches are sent to
// Gemini for a binary YES/NO; per-pair failures degrade to null (treated as
// "keep the match, flag for review" by the matcher, matching haqita), and a
// daily-quota error stops the remaining pairs — the run continues, because
// the OCR that produced these items is already paid for.

import { Data, Effect } from 'effect'

import type { GeminiClient } from './gemini.js'
import { lazyGeminiClient } from '../util/gemini.js'
import type { ModelChainState } from '../util/model-chain.js'
import { withModelFallback } from '../util/model-chain.js'
import { classifyQuotaError, withQuotaPolicy, QuotaExhausted } from '../util/retry.js'

// Ported verbatim from haqita matcher.py — the prompt is load-bearing for
// verifier precision; change it deliberately, not casually.
export const AI_PROMPT_TEMPLATE = `You are comparing grocery products from two Indonesian supermarket brochures.
Decide if these two listings refer to the SAME physical product.

Product A ({storeA}): "{nameA}" — {unitA} — Rp {priceA}
Product B ({storeB}): "{nameB}" — {unitB} — Rp {priceB}

Rules:
- SAME: same brand, same variant, same (or very close) size
- DIFFERENT: different brand, different variant, OR clearly different size (e.g. 85g vs 250g)
- OCR spelling typos do NOT make products different
- Different pack sizes are DIFFERENT even if per-unit price is similar

Reply with exactly one word: YES or NO`

export interface VerifyPair {
  storeA: string
  nameA: string
  unitA?: string | null
  priceA: number
  storeB: string
  nameB: string
  unitB?: string | null
  priceB: number
}

export function buildVerifyPrompt(pair: VerifyPair): string {
  return AI_PROMPT_TEMPLATE.replace('{storeA}', pair.storeA)
    .replace('{nameA}', pair.nameA)
    .replace('{unitA}', pair.unitA ?? '')
    .replace('{priceA}', pair.priceA.toLocaleString('en-US'))
    .replace('{storeB}', pair.storeB)
    .replace('{nameB}', pair.nameB)
    .replace('{unitB}', pair.unitB ?? '')
    .replace('{priceB}', pair.priceB.toLocaleString('en-US'))
}

export interface VerifyOutcome {
  /** Per-pair answer: 'YES' | 'NO' | null (unparseable/retried-out/quota). */
  answers: ('YES' | 'NO' | null)[]
  /** True when the daily quota stopped the sweep early. */
  quotaExhausted: boolean
}

export class VerifierError extends Data.TaggedError('VerifierError')<{
  message: string
}> {}

export interface VerifyOptions {
  apiKey?: string
  /** A single pinned id, or the verifier's own per-run chain state. */
  model: string | ModelChainState
  /** Extra attempts after the first per pair (quota-aware policy). */
  retries?: number
  client?: GeminiClient
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

function parseAnswer(text: string | undefined | null): 'YES' | 'NO' | null {
  const reply = (text ?? '').trim().toUpperCase()
  if (reply.includes('YES')) return 'YES'
  if (reply.includes('NO')) return 'NO'
  return null
}

/**
 * Send pairs to Gemini for binary verification. One call per pair, retried
 * transiently, with the model-fallback chain wrapping each pair (issue
 * #347): a model-fatal 404 or saturation advances the verifier's own chain
 * and the pair is retried on the next rung instead of being nulled. A pair
 * that still fails yields null and the sweep continues. Quota exhaustion is
 * handled internally (the sweep stops, remaining pairs report null,
 * `quotaExhausted: true` — now meaning the verifier's WHOLE chain is
 * quota-dead) — the only failure that escapes is a client bootstrap problem
 * (missing API key).
 */
export function verifyPairs(
  pairs: VerifyPair[],
  options: VerifyOptions
): Effect.Effect<VerifyOutcome, VerifierError> {
  // The client (and its API key requirement) is resolved lazily: a run with
  // no ambiguous pairs makes no verifier calls.
  const resolveClient = lazyGeminiClient({
    client: options.client,
    apiKey: options.apiKey,
    tag: VerifierError,
  })

  // The null-swallow lives in the sweep, not here: a model-fatal VerifierError
  // must escape so withModelFallback can advance the chain before the pair is
  // given up on (the text-based classifiers see through the wrapper verbatim).
  const verifyOne = (
    pair: VerifyPair,
    client: GeminiClient,
    model: string
  ): Effect.Effect<'YES' | 'NO' | null, QuotaExhausted | VerifierError> =>
    withQuotaPolicy(
      Effect.tryPromise({
        try: () =>
          client.models.generateContent({
            model,
            contents: [{ parts: [{ text: buildVerifyPrompt(pair) }] }],
          }),
        catch: (cause: unknown) =>
          classifyQuotaError(cause) ??
          new VerifierError({
            message: `AI verification failed for "${pair.nameA}" vs "${pair.nameB}": ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
      }),
      {
        retries: options.retries ?? 3,
        context: 'ai_verifier',
        sleep: options.sleep,
        log: options.log,
      }
    ).pipe(Effect.map((response) => parseAnswer((response as { text?: string }).text)))

  return Effect.gen(function* () {
    if (pairs.length === 0) return { answers: [], quotaExhausted: false }
    const activeClient = yield* resolveClient()

    const answers: ('YES' | 'NO' | null)[] = []
    for (const pair of pairs) {
      const answer = yield* withModelFallback(
        options.model,
        (model) => verifyOne(pair, activeClient, model),
        options.log
      ).pipe(
        // Transient errors that outlived the ladder leave the pair
        // unverifiable (null) — the matcher keeps the pair and flags it for
        // review, exactly like haqita's _verify_one_pair returning None.
        Effect.catchIf(
          (error): error is VerifierError => error instanceof VerifierError,
          () => Effect.succeed(null)
        )
      )
      answers.push(answer)
    }
    return { answers, quotaExhausted: false }
  }).pipe(
    // Daily quota on the LAST rung stops the sweep: remaining pairs get null
    // and the run's paid-for OCR still publishes.
    Effect.catchTag('QuotaExhausted', (error) =>
      Effect.sync(() => {
        options.log?.(`[ai_verifier] Stopping early: ${error.message}`)
        return {
          answers: Array<'YES' | 'NO' | null>(pairs.length).fill(null),
          quotaExhausted: true,
        } satisfies VerifyOutcome
      })
    )
  )
}
