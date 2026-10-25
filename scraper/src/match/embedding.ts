// Gemini text embeddings — replaces haqita's sentence-transformers model
// (paraphrase-multilingual-MiniLM-L12-v2) per docs/plan/haqita-integration.md
// §6: no torch on the disk-scarce VPS. Vectors are cached on disk keyed by
// input text so repeat runs (novelty-filtered) cost nothing; a model change
// discards the cache because vectors from different models are incomparable.

import { Data, Effect } from 'effect'

import { classifyQuotaError, withQuotaPolicy, type QuotaExhausted } from '../util/retry.js'

/** Structural slice of @google/genai's client — the real thing satisfies it. */
export interface EmbeddingClient {
  models: {
    embedContent(args: {
      model: string
      contents: string
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

/**
 * Embed `texts`, filling cache misses through the Gemini embedding API.
 * Cached texts are never re-requested. Failures are typed errors the caller
 * degrades from (exact-only matching) — embedding trouble must not kill a
 * run whose OCR is already paid for.
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
  let client: EmbeddingClient | undefined = options.client
  const resolveClient = (): Effect.Effect<EmbeddingClient, EmbeddingError> =>
    Effect.suspend(() =>
      client
        ? Effect.succeed(client)
        : Effect.tryPromise({
            try: async () => {
              const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY
              if (!apiKey) throw new Error('GEMINI_API_KEY not set (or pass options.apiKey)')
              const { GoogleGenAI } = await import('@google/genai')
              client = new GoogleGenAI({ apiKey })
              return client as unknown as EmbeddingClient
            },
            catch: (cause: unknown) => new EmbeddingError({ message: String(cause) }),
          })
    )

  return Effect.gen(function* () {
    const activeClient = yield* resolveClient()
    for (const text of misses) {
      const response = yield* withQuotaPolicy(
        Effect.tryPromise({
          try: () => activeClient.models.embedContent({ model: options.model, contents: text }),
          catch: (cause: unknown) =>
            classifyQuotaError(cause) ??
            new EmbeddingError({
              message: `Embedding failed for "${text.slice(0, 60)}": ${
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
      const values = response.embeddings?.[0]?.values
      if (!values || values.length === 0) {
        return yield* Effect.fail(
          new EmbeddingError({ message: `Empty embedding vector for "${text.slice(0, 60)}"` })
        )
      }
      cache.vectors[text] = values
    }
    return cache.vectors
  })
}
