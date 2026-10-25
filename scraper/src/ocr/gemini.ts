// Gemini vision OCR — port of haqita scripts/ocr/gemini_client.py + prompts.
// The SDK client is injected so tests never touch the network. Failures are
// typed: `QuotaExhausted` aborts the run (exit 2), everything else is an
// `OcrError` retried by the quota-aware policy.

import { Data, Effect } from 'effect'

import type { RawOcrItem } from './parse.js'
import { parseOcrJson } from './parse.js'
import { lazyGeminiClient } from '../util/gemini.js'
import { classifyQuotaError, QuotaExhausted, withQuotaPolicy } from '../util/retry.js'

// Ported verbatim from haqita scripts/ocr/prompts/gemini.py — the prompt is
// load-bearing for extraction quality; change it deliberately, not casually.
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
- DO NOT include both "original_price" and "discounted_price" in "promo"
- Field "price" MUST be an integer. Indonesian '.' separator: "Rp 8.500" → 8500. Exactly as shown in brochure, do not convert to per-unit price or apply any discount calculation.
- Extract EVERY product visible, including small items.`

const PROMPTS: Record<string, string> = {
  superindo: `Extract all product promotions from this Superindo supermarket brochure image.\n\n${PROMPT_BODY}`,
  'lotte-mart': `Extract all product promotions from this Lotte Mart supermarket brochure image.\n\n${PROMPT_BODY}`,
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

export interface OcrOptions {
  apiKey?: string
  model: string
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
  ): Effect.Effect<RawOcrItem[], OcrError | QuotaExhausted>
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
    ): Effect.Effect<RawOcrItem[], OcrError | QuotaExhausted> {
      return Effect.gen(function* () {
        const activeClient = yield* resolveClient()
        const base64 = Buffer.from(imageBytes).toString('base64')
        const response = yield* withQuotaPolicy(
          Effect.tryPromise({
            try: () =>
              activeClient.models.generateContent({
                model: options.model,
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
