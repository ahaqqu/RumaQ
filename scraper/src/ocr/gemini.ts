// Gemini vision OCR — port of haqita scripts/ocr/gemini_client.py + prompts.
// The SDK client is injected so tests never touch the network. Failures are
// typed: a rung's failure is an `OcrError` (or `QuotaExhausted`) retried by
// the quota-aware policy, then classified by the model-fallback chain
// (issue #347); only a whole-dead chain surfaces, as `ChainExhaustedError`
// riding per-store isolation.

import { Data, Effect } from 'effect'

import type { RawOcrItem } from './parse.js'
import { parseOcrJson } from './parse.js'
import { lazyGeminiClient } from '../util/gemini.js'
import type { ModelChainState } from '../util/model-chain.js'
import { withModelFallback } from '../util/model-chain.js'
import { classifyQuotaError, QuotaExhausted, withQuotaPolicy } from '../util/retry.js'

// Ported verbatim from haqita scripts/ocr/prompts/gemini.py — the prompt is
// load-bearing for extraction quality; change it deliberately, not casually.
// Sole deliberate change (issue #367): one added originalPrice rule below.
const PROMPT_BODY = `Return ONLY a valid JSON array. No explanation. No markdown. Start with [ and end with ].

Each item must follow this exact structure:
{
  "name": "full product name as shown",
  "brand": "brand name if visible, else null",
  "unit": "size as shown (e.g. '85 g', '1.5 L', '6 x 45 ml'), else null",
  "price": <integer in IDR, numbers only, as shown in brochure as per definition in rules below>,
  "promo": <an array of promo texts if shown (e.g. 'MAX 1', 'LOTTE MART Point SPECIAL PRICE', 'Dapat 5 pcs', 'BUY 1 GET 1'), else null>,
  "period": "validity dates if shown, else null"
}

Rules:
- Brochure may show both "original_price" and "discounted_price".
- "discounted_price" usually red font or red background, but not always.
- "original_price" usually black font, but not always.
- If both prices shown, put "discounted_price" in "price" field.
- If only one price is shown, put it in "price" field.
- If an original (strikethrough) price is shown, also emit it as "originalPrice" (integer in IDR, same rule as "price"), else "originalPrice" is null.
- DO NOT include both "original_price" and "discounted_price" in "promo"
- Field "price" MUST be an integer. Indonesian '.' separator: "Rp 8.500" → 8500. Exactly as shown in brochure, do not convert to per-unit price or apply any discount calculation.
- Extract EVERY product visible, including small items.`

const PROMPTS: Record<string, string> = {
  superindo: `Extract all product promotions from this Superindo supermarket brochure image.\n\n${PROMPT_BODY}`,
  'lotte-mart': `Extract all product promotions from this Lotte Mart supermarket brochure image.\n\n${PROMPT_BODY}`,
  hypermart: `Extract all product promotions from this Hypermart supermarket brochure image.\n\n${PROMPT_BODY}`,
  indomaret: `Extract all product promotions from this Indomaret supermarket brochure image.\n\n${PROMPT_BODY}`,
}

export function getPrompt(storeSlug: string): string {
  const prompt = PROMPTS[storeSlug]
  // The prompt table and the store registry live in the same package — a
  // missing prompt is a programming error, not a runtime condition.
  if (!prompt) throw new Error(`No OCR prompt registered for store "${storeSlug}"`)
  return prompt
}

/** Structural slice of @google/genai's client — the real thing satisfies it. */
export interface GeminiClient {
  models: {
    generateContent(args: {
      model: string
      contents: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[]
    }): Promise<{ text?: string }>
  }
}

export class OcrError extends Data.TaggedError('OcrError')<{
  message: string
}> {}

/**
 * Every rung of the store's model chain is dead (issue #347, design C1). NOT
 * a quota error: it rides per-store isolation (exit 1, run continues, monitor
 * red) instead of the run-aborting QuotaExhausted path — "run continues,
 * monitor red" is the owner's binding semantics. Later OCR calls short-circuit
 * to this with zero network calls once the chain state reports exhausted.
 */
export class ChainExhaustedError extends Data.TaggedError('ChainExhaustedError')<{
  message: string
}> {}

function chainExhaustedError(state: ModelChainState): ChainExhaustedError {
  return new ChainExhaustedError({
    message:
      `all ${state.chain.length} chain rungs exhausted — ` +
      state.deaths.map((death) => `${death.model} (${death.reason})`).join('; '),
  })
}

export interface OcrOptions {
  apiKey?: string
  /** A single pinned id, or the per-run chain state (rungs read per call). */
  model: string | ModelChainState
  storeSlug: string
  /** Extra attempts after the first (quota-aware policy). */
  retries?: number
  client?: GeminiClient
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export interface Ocr {
  /** OCR one brochure page; returns raw items (validate separately). */
  ocrImage(
    imageBytes: Uint8Array,
    mimeType?: string
  ): Effect.Effect<RawOcrItem[], OcrError | ChainExhaustedError | QuotaExhausted>
}

export function createOcr(options: OcrOptions): Ocr {
  const prompt = getPrompt(options.storeSlug)

  // The client (and its API key requirement) is resolved lazily on the first
  // ocrImage call: a run with zero new images makes no OCR calls and must
  // work without GEMINI_API_KEY.
  const resolveClient = lazyGeminiClient({
    client: options.client,
    apiKey: options.apiKey,
    tag: OcrError,
  })

  return {
    ocrImage(
      imageBytes: Uint8Array,
      mimeType = 'image/jpeg'
    ): Effect.Effect<RawOcrItem[], OcrError | ChainExhaustedError | QuotaExhausted> {
      const chainState = typeof options.model === 'string' ? undefined : options.model
      return Effect.gen(function* () {
        // All-dead short-circuit (design C1): once the chain is exhausted,
        // every later page and store fails here with ZERO network calls —
        // "run continues" costs nothing.
        if (chainState?.exhausted) return yield* chainExhaustedError(chainState)
        const activeClient = yield* resolveClient()
        const base64 = Buffer.from(imageBytes).toString('base64')
        const attempt = (model: string) =>
          withQuotaPolicy(
            Effect.tryPromise({
              try: () =>
                activeClient.models.generateContent({
                  model,
                  contents: [
                    { parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] },
                  ],
                }),
              catch: (cause: unknown) =>
                classifyQuotaError(cause) ??
                new OcrError({ message: cause instanceof Error ? cause.message : String(cause) }),
            }),
            {
              retries: options.retries ?? 2,
              context: 'gemini_ocr',
              sleep: options.sleep,
              log: options.log,
            }
          )
        const response = yield* withModelFallback(options.model, attempt, options.log).pipe(
          // All rungs died on this call (whatever the causes): map the escaped
          // error to the typed isolation error. Deliberately catches
          // QuotaExhausted too — with the chain, quota death is per-rung and
          // only surfaces once the WHOLE chain is dead, and that is a
          // per-store failure (exit 1), not a run abort (exit 2, design C1).
          Effect.catchIf(
            () => chainState?.exhausted === true,
            () => Effect.fail(chainExhaustedError(chainState!))
          )
        )
        const text = (response as { text?: string }).text
        if (!text) return yield* new OcrError({ message: 'Gemini OCR returned empty response' })
        return yield* Effect.try({
          try: () => parseOcrJson(text),
          catch: (cause: unknown) =>
            classifyQuotaError(cause) ??
            new OcrError({ message: cause instanceof Error ? cause.message : String(cause) }),
        })
      })
    },
  }
}
