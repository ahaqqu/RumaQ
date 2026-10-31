// Gemini OCR client tests — the SDK client is injected, so no network.
// ocrImage is an Effect — driven through Effect.runPromise.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vite-plus/test'
import { Effect } from 'effect'

import { createOcr, getPrompt, type GeminiClient } from '../../src/ocr/gemini.js'
import type { RawOcrItem } from '../../src/ocr/parse.js'
import { createModelChain } from '../../src/util/model-chain.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Verbatim Gemini output saved by haqita for the superindo katalog fixture —
// wrapped in the markdown fence the model actually emits.
const sampleItems: RawOcrItem[] = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/superindo/gemini-sample-response.json'), 'utf8')
)

describe('getPrompt', () => {
  it('uses the store-specific intro', () => {
    expect(getPrompt('superindo')).toContain('Superindo supermarket brochure image')
    expect(getPrompt('lotte-mart')).toContain('Lotte Mart supermarket brochure image')
  })

  it('throws for stores without a registered prompt instead of falling back', () => {
    expect(() => getPrompt('unknown-store')).toThrow('No OCR prompt registered')
  })

  it('carries the load-bearing JSON rules verbatim', () => {
    const prompt = getPrompt('superindo')
    expect(prompt).toContain('Return ONLY a valid JSON array')
    expect(prompt).toContain('"Rp 8.500" → 8500')
    expect(prompt).toContain('Extract EVERY product visible, including small items.')
  })
})

function stubClient(
  responseText: string,
  onError?: (calls: number) => Error | null
): {
  client: GeminiClient
  calls: () => number
  lastArgs: () => { model: string; parts: unknown[] } | undefined
} {
  let calls = 0
  let last: { model: string; parts: unknown[] } | undefined
  const client: GeminiClient = {
    models: {
      generateContent: async (args) => {
        calls++
        last = { model: args.model, parts: args.contents[0]!.parts }
        const error = onError?.(calls)
        if (error) throw error
        return { text: responseText }
      },
    },
  }
  return { client, calls: () => calls, lastArgs: () => last }
}

describe('createOcr', () => {
  it('sends prompt + base64 image to the configured model and parses items', async () => {
    const { client, calls, lastArgs } = stubClient(
      '```json\n' + JSON.stringify(sampleItems) + '\n```'
    )
    const ocr = createOcr({ model: 'gemini-3.5-flash', storeSlug: 'superindo', client })
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const items = await Effect.runPromise(ocr.ocrImage(imageBytes))

    expect(calls()).toBe(1)
    expect(lastArgs()!.model).toBe('gemini-3.5-flash')
    const parts = lastArgs()!.parts as { text?: string; inlineData?: { data: string } }[]
    expect(parts[0]!.text).toContain('Superindo supermarket brochure image')
    expect(parts[1]!.inlineData!.data).toBe(Buffer.from(imageBytes).toString('base64'))
    expect(items).toEqual(sampleItems)
  })

  it('declares the caller-provided mimeType in inlineData (PNG pages are not jpeg)', async () => {
    const { client, lastArgs } = stubClient('[]')
    const ocr = createOcr({ model: 'gemini-3.5-flash', storeSlug: 'superindo', client })
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await Effect.runPromise(ocr.ocrImage(pngBytes, 'image/png'))
    const parts = lastArgs()!.parts as { inlineData?: { mimeType: string } }[]
    expect(parts[1]!.inlineData!.mimeType).toBe('image/png')
  })

  it('retries transient errors with the quota-aware policy', async () => {
    let failures = 0
    const { client, calls } = stubClient(JSON.stringify(sampleItems), (attempt) => {
      if (attempt === 1) {
        failures++
        return new Error('500 backend error')
      }
      return null
    })
    const ocr = createOcr({
      model: 'gemini-3.5-flash',
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
    })
    const items = await Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))
    expect(failures).toBe(1)
    expect(calls()).toBe(2)
    expect(items).toEqual(sampleItems)
  })

  it('stops immediately on daily quota exhaustion', async () => {
    const { client, calls } = stubClient(
      '[]',
      () => new Error('429 Quota exceeded for GenerateRequests per day')
    )
    const ocr = createOcr({
      model: 'gemini-3.5-flash',
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
    })
    await expect(Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))).rejects.toThrow(
      /Daily quota exhausted/
    )
    expect(calls()).toBe(1)
  })

  it('fails on empty responses', async () => {
    const { client } = stubClient('')
    const ocr = createOcr({
      model: 'm',
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
    })
    await expect(Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))).rejects.toThrow(
      'empty response'
    )
  })

  it('constructs without an API key and only requires it on the first OCR call', async () => {
    const previous = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      // No failure yet — a run with zero new images never makes an OCR call.
      const ocr = createOcr({ model: 'm', storeSlug: 'superindo' })
      await expect(Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))).rejects.toThrow(
        'GEMINI_API_KEY not set'
      )
    } finally {
      if (previous !== undefined) process.env.GEMINI_API_KEY = previous
    }
  })

  it('logs retry waits when a logger is provided', async () => {
    const log = vi.fn()
    let attempt = 0
    const client: GeminiClient = {
      models: {
        generateContent: async () => {
          attempt++
          if (attempt === 1) throw new Error('429 RESOURCE_EXHAUSTED: retry in 30s')
          return { text: '[]' }
        },
      },
    }
    const ocr = createOcr({
      model: 'm',
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
      log,
    })
    await Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Rate limit hit'))
  })
})

// Model-chain consumption (issue #347) — the OCR boundary advances the
// per-run chain state on a ladder-escaped trigger error and isolates a
// whole-dead chain as ChainExhaustedError. Fixture bodies verbatim from
// retry.test.ts.

describe('createOcr — model chain', () => {
  const DAILY_429 = () =>
    new Error(
      '429 You have exhausted your daily quota. QuotaID: GenerateRequestsPerDayPerProjectPerModel-FreeTier'
    )

  function recordingClient(
    respond: (call: { model: string }) => { text: string } | Error
  ): GeminiClient & { calls: { model: string }[] } {
    const state = { calls: [] as { model: string }[], n: 0 }
    const client = {
      models: {
        generateContent: async (args: { model: string }) => {
          state.n++
          const record = { model: args.model }
          state.calls.push(record)
          const result = respond(record)
          if (result instanceof Error) throw result
          return result
        },
      },
    }
    return Object.assign(client, state)
  }

  it('advances the chain on a daily-quota 429 and retries the page on the next rung', async () => {
    const client = recordingClient(({ model }) =>
      model === 'gemini-a' ? DAILY_429() : { text: JSON.stringify(sampleItems) }
    )
    const ocr = createOcr({
      model: createModelChain(['gemini-a', 'gemini-b']),
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
    })
    const items = await Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))
    expect(items).toEqual(sampleItems)
    expect(client.calls.map((call) => call.model)).toEqual(['gemini-a', 'gemini-b'])
  })

  it('skips a model-fatal 404 rung at the cost of one call', async () => {
    const MODEL_GONE_404 =
      '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash …","status":"NOT_FOUND"}}'
    const client = recordingClient(({ model }) =>
      model === 'gemini-a' ? new Error(MODEL_GONE_404) : { text: JSON.stringify(sampleItems) }
    )
    const ocr = createOcr({
      model: createModelChain(['gemini-a', 'gemini-b']),
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
    })
    const items = await Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))
    expect(items).toEqual(sampleItems)
    expect(client.calls.map((call) => call.model)).toEqual(['gemini-a', 'gemini-b'])
  })

  it('never advances on a per-minute 429 — the error propagates, the next rung is untouched', async () => {
    const client = recordingClient(() => new Error('429 RESOURCE_EXHAUSTED: retry in 30s'))
    const ocr = createOcr({
      model: createModelChain(['gemini-a', 'gemini-b']),
      storeSlug: 'superindo',
      client,
      retries: 2,
      sleep: async () => {},
    })
    await expect(Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))).rejects.toThrow(/retry in 30s/)
    // 1 initial + 2 ladder retries, all on rung 0 — rung 1 never called.
    expect(client.calls.map((call) => call.model)).toEqual(['gemini-a', 'gemini-a', 'gemini-a'])
  })

  it('maps a whole-dead chain to ChainExhaustedError and short-circuits later calls with zero network', async () => {
    const client = recordingClient(() => DAILY_429())
    const chain = createModelChain(['gemini-a', 'gemini-b'], 'ocr')
    const ocr = createOcr({
      model: chain,
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
    })
    // One call per rung (quota errors never retry), then the typed
    // all-dead error — not QuotaExhausted, so it rides per-store isolation.
    await expect(Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))).rejects.toThrow(
      /all 2 chain rungs exhausted — gemini-a \(daily-quota 429\); gemini-b \(daily-quota 429\)/
    )
    expect(client.calls.map((call) => call.model)).toEqual(['gemini-a', 'gemini-b'])

    // The next page (and every later store) short-circuits: zero calls.
    await expect(Effect.runPromise(ocr.ocrImage(new Uint8Array(4)))).rejects.toThrow(
      /all 2 chain rungs exhausted/
    )
    expect(client.calls).toHaveLength(2)
  })
})
