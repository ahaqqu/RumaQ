// Port of haqita tests/matching/test_matcher.py TestGeminiVerify — prompt
// formatting, answer parsing, retry/quota semantics — adapted to the typed
// verifyPairs (quota is handled internally, exposing quotaExhausted).

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import { buildVerifyPrompt, verifyPairs, type VerifyPair } from '../../src/ocr/verify.js'
import type { GeminiClient } from '../../src/ocr/gemini.js'

const PAIR: VerifyPair = {
  storeA: 'Lotte',
  nameA: 'Indomie Goreng',
  unitA: '85 g',
  priceA: 3500,
  storeB: 'Superindo',
  nameB: 'Indomie Goreng',
  unitB: '85 g',
  priceB: 3200,
}

function client(script: (string | Error)[]): GeminiClient & { calls: number } {
  const c = {
    calls: 0,
    models: {
      generateContent: async (): Promise<{ text?: string }> => {
        const step = script[Math.min(c.calls, script.length - 1)]
        c.calls++
        if (step instanceof Error) throw step
        return { text: step }
      },
    },
  }
  return c
}

const OPTS = (c: GeminiClient) => ({
  model: 'v',
  retries: 2,
  client: c,
  sleep: async () => {},
  log: () => {},
})

describe('buildVerifyPrompt', () => {
  it('formats the verbatim template with stores, names, units and comma prices', () => {
    const prompt = buildVerifyPrompt(PAIR)
    expect(prompt).toContain('Product A (Lotte): "Indomie Goreng" — 85 g — Rp 3,500')
    expect(prompt).toContain('Product B (Superindo): "Indomie Goreng" — 85 g — Rp 3,200')
    expect(prompt).toContain('Reply with exactly one word: YES or NO')
  })
})

describe('verifyPairs', () => {
  it('returns empty for no pairs without touching the client', async () => {
    const c = client([])
    const outcome = await Effect.runPromise(verifyPairs([], OPTS(c)))
    expect(outcome).toEqual({ answers: [], quotaExhausted: false })
    expect(c.calls).toBe(0)
  })

  it('parses YES and NO answers per pair', async () => {
    const c = client(['YES', 'NO'])
    const outcome = await Effect.runPromise(
      verifyPairs([PAIR, { ...PAIR, nameB: 'Ultra Milk' }], OPTS(c))
    )
    expect(outcome.answers).toEqual(['YES', 'NO'])
    expect(outcome.quotaExhausted).toBe(false)
  })

  it('retries transient 503s then succeeds (per pair)', async () => {
    const c = client([new Error('503 UNAVAILABLE'), new Error('503 UNAVAILABLE'), 'YES'])
    const outcome = await Effect.runPromise(verifyPairs([PAIR], OPTS(c)))
    expect(outcome.answers).toEqual(['YES'])
    expect(c.calls).toBe(3)
  })

  it('yields null when retries run out', async () => {
    const c = client([new Error('503 UNAVAILABLE')])
    const outcome = await Effect.runPromise(verifyPairs([PAIR], { ...OPTS(c), retries: 2 }))
    expect(outcome.answers).toEqual([null])
    expect(c.calls).toBe(3) // 1 initial + 2 retries
  })

  it('fails a fatal model-gone 404 fast: one call per pair, no retry burn', async () => {
    // Verbatim issue #306 live-log failure — a deprecated model id never
    // recovers, so the pair degrades to null immediately and the sweep moves
    // on instead of burning 3 retries per pair.
    const c = client([
      new Error(
        '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash …","status":"NOT_FOUND"}}'
      ),
    ])
    const outcome = await Effect.runPromise(
      verifyPairs([PAIR, { ...PAIR, nameA: 'Other' }], OPTS(c))
    )
    expect(outcome.answers).toEqual([null, null])
    expect(outcome.quotaExhausted).toBe(false)
    expect(c.calls).toBe(2) // exactly 1 per pair
  })

  it('sleeps the parsed delay for per-minute rate limits', async () => {
    const sleeps: number[] = []
    const c = client([new Error('429 RESOURCE_EXHAUSTED: Please retry in 30s'), 'YES'])
    const outcome = await Effect.runPromise(
      verifyPairs([PAIR], {
        model: 'v',
        retries: 2,
        client: c,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        log: () => {},
      })
    )
    expect(outcome.answers).toEqual(['YES'])
    expect(sleeps).toEqual([45000]) // 30s + 15s grace, ms
  })

  it('daily quota stops the sweep: one call, remaining pairs null', async () => {
    const c = client([
      new Error('429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric GenerateRequests per day'),
    ])
    const outcome = await Effect.runPromise(
      verifyPairs([PAIR, { ...PAIR, nameA: 'Other' }], OPTS(c))
    )
    expect(outcome.quotaExhausted).toBe(true)
    expect(outcome.answers).toEqual([null, null])
    expect(c.calls).toBe(1)
  })

  it('per-pair retries are independent', async () => {
    const c = client([new Error('503 UNAVAILABLE'), 'YES', 'NO', 'YES'])
    const outcome = await Effect.runPromise(
      verifyPairs([PAIR, { ...PAIR, nameA: 'B' }, { ...PAIR, nameA: 'C' }], OPTS(c))
    )
    expect(outcome.answers).toEqual(['YES', 'NO', 'YES'])
    expect(c.calls).toBe(4)
  })
})
