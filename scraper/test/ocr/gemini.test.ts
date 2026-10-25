// Gemini OCR client tests — the SDK client is injected, so no network.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vite-plus/test'

import { createOcr, getPrompt, type GeminiClient } from '../../src/ocr/gemini.js'
import type { RawOcrItem } from '../../src/ocr/parse.js'

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

  it('falls back to superindo for unknown stores', () => {
    expect(getPrompt('unknown-store')).toBe(getPrompt('superindo'))
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
    const ocr = await createOcr({ model: 'gemini-3.5-flash', storeSlug: 'superindo', client })
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const items = await ocr.ocrImage(imageBytes)

    expect(calls()).toBe(1)
    expect(lastArgs()!.model).toBe('gemini-3.5-flash')
    const parts = lastArgs()!.parts as { text?: string; inlineData?: { data: string } }[]
    expect(parts[0]!.text).toContain('Superindo supermarket brochure image')
    expect(parts[1]!.inlineData!.data).toBe(Buffer.from(imageBytes).toString('base64'))
    expect(items).toEqual(sampleItems)
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
    const ocr = await createOcr({
      model: 'gemini-3.5-flash',
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
    })
    const items = await ocr.ocrImage(new Uint8Array(4))
    expect(failures).toBe(1)
    expect(calls()).toBe(2)
    expect(items).toEqual(sampleItems)
  })

  it('stops immediately on daily quota exhaustion', async () => {
    const { client, calls } = stubClient(
      '[]',
      () => new Error('429 Quota exceeded for GenerateRequests per day')
    )
    const ocr = await createOcr({
      model: 'gemini-3.5-flash',
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
    })
    await expect(ocr.ocrImage(new Uint8Array(4))).rejects.toThrow(/Daily quota exhausted/)
    expect(calls()).toBe(1)
  })

  it('fails on empty responses', async () => {
    const { client } = stubClient('')
    const ocr = await createOcr({
      model: 'm',
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
    })
    await expect(ocr.ocrImage(new Uint8Array(4))).rejects.toThrow('empty response')
  })

  it('requires an API key when no client is injected', async () => {
    const previous = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      await expect(createOcr({ model: 'm', storeSlug: 'superindo' })).rejects.toThrow(
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
    const ocr = await createOcr({
      model: 'm',
      storeSlug: 'superindo',
      client,
      sleep: async () => {},
      log,
    })
    await ocr.ocrImage(new Uint8Array(4))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Rate limit hit'))
  })
})
