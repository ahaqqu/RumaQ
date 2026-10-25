// One canonical lazy Gemini SDK bootstrap, shared by the OCR stage, the AI
// verifier, and the embedding client (mirroring how util/retry.ts centralized
// the retry engines). The pattern is deliberately lazy — resolve
// GEMINI_API_KEY, dynamic-import @google/genai, memoize — because the SDK is
// an optional runtime dependency that must never load in tests or plain
// environments, and a run that never calls Gemini (all-cached, no new images)
// must work without an API key. Each call site keeps its own typed error via
// `tag` so `catchTag` keeps working.

import { Effect } from 'effect'

/**
 * Build a lazy client resolver. The returned function resolves (and memoizes)
 * the SDK client on first call; an injected `client` short-circuits the
 * bootstrap entirely (tests). Bootstrap failures surface as the caller's
 * typed error `tag`.
 */
export function lazyGeminiClient<C, E>(options: {
  /** Pre-built client (tests inject a stub); bypasses the bootstrap. */
  client?: C
  /** API key override; defaults to GEMINI_API_KEY. */
  apiKey?: string
  /** Caller's typed error for bootstrap failures (kept for catchTag). */
  tag: new (args: { message: string }) => E
}): () => Effect.Effect<C, E> {
  let client: C | undefined = options.client
  return () =>
    Effect.suspend(() =>
      client
        ? Effect.succeed(client)
        : Effect.tryPromise({
            try: async () => {
              const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY
              if (!apiKey) throw new Error('GEMINI_API_KEY not set (or pass options.apiKey)')
              const { GoogleGenAI } = await import('@google/genai')
              client = new GoogleGenAI({ apiKey }) as unknown as C
              return client
            },
            catch: (cause: unknown) => new options.tag({ message: String(cause) }),
          })
    )
}
