// Gemini text embeddings — replaces haqita's sentence-transformers model
// (paraphrase-multilingual-MiniLM-L12-v2) per docs/plan/haqita-integration.md
// §6: no torch on the disk-scarce VPS. Vectors are cached on disk keyed by
// input text so repeat runs (novelty-filtered) cost nothing; a model change
// discards the cache because vectors from different models are incomparable.

import { Data, Effect } from 'effect'

import { lazyGeminiClient } from '../util/gemini.js'
import { classifyQuotaError, withQuotaPolicy, type QuotaExhausted } from '../util/retry.js'

/** Structural slice of @google/genai's client — the real thing satisfies it. */
export interface EmbeddingClient {
  models: {
    // embedContent with a `contents` array is the SDK's batch embedding path
    // (the bundled @google/genai 1.52.0 no longer exposes
    // models.batchEmbedContents; the single call still posts to the
    // batchEmbedContents REST endpoint and returns one vector per input).
    embedContent(args: {
      model: string
      contents: string[]
    }): Promise<{ embeddings?: { values?: number[] }[] }>
  }
}

export class EmbeddingError extends Data.TaggedError('EmbeddingError')<{
  message: string
}> {}

/** On-disk cache file shape (state dir, embeddings.json). */
export interface EmbeddingCache {
  model: string
  /** input text → vector */
  vectors: Record<string, number[]>
}

export function emptyCache(model: string): EmbeddingCache {
  return { model, vectors: {} }
}

/** Cosine similarity — the only metric the gates need. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

export interface EmbedOptions {
  apiKey?: string
  model: string
  /** Extra attempts after the first (quota-aware policy). */
  retries?: number
  client?: EmbeddingClient
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/** Texts per embedContent call — the API's per-request batch ceiling. */
const BATCH_SIZE = 100

/**
 * Embed `texts`, filling cache misses through the Gemini batch embedding
 * API. Cached texts are never re-requested; misses ride batched calls (a
 * cold cache — model bump or fresh box — costs O(catalog/100) round trips,
 * not O(catalog)). Failures are typed errors the caller degrades from
 * (exact-only matching) — embedding trouble must not kill a run whose OCR
 * is already paid for.
 */
export function embedNames(
  texts: string[],
  cache: EmbeddingCache,
  options: EmbedOptions
): Effect.Effect<Record<string, number[]>, EmbeddingError | QuotaExhausted> {
  const misses = [...new Set(texts)].filter((text) => !(text in cache.vectors))
  if (misses.length === 0) return Effect.succeed(cache.vectors)

  // The client (and its API key requirement) is resolved lazily: a run whose
  // items all hit the cache needs no GEMINI_API_KEY.
  const resolveClient = lazyGeminiClient({
    client: options.client,
    apiKey: options.apiKey,
    tag: EmbeddingError,
  })

  return Effect.gen(function* () {
    const activeClient = yield* resolveClient()
    for (let start = 0; start < misses.length; start += BATCH_SIZE) {
      const batch = misses.slice(start, start + BATCH_SIZE)
      const response = yield* withQuotaPolicy(
        Effect.tryPromise({
          try: () =>
            activeClient.models.embedContent({
              model: options.model,
              contents: batch,
            }),
          catch: (cause: unknown) =>
            classifyQuotaError(cause) ??
            new EmbeddingError({
              message: `Embedding batch failed (${batch.length} texts, first "${batch[0]!.slice(0, 60)}"): ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            }),
        }),
        {
          retries: options.retries ?? 2,
          context: 'gemini_embedding',
          sleep: options.sleep,
          log: options.log,
        }
      )
      const vectors = response.embeddings ?? []
      if (vectors.length !== batch.length) {
        return yield* Effect.fail(
          new EmbeddingError({
            message: `Embedding batch returned ${vectors.length} vectors for ${batch.length} texts`,
          })
        )
      }
      for (let i = 0; i < vectors.length; i++) {
        const values = vectors[i]!.values
        if (!values || values.length === 0) {
          return yield* Effect.fail(
            new EmbeddingError({
              message: `Empty embedding vector for "${batch[i]!.slice(0, 60)}"`,
            })
          )
        }
        cache.vectors[batch[i]!] = values
      }
    }
    return cache.vectors
  })
}
