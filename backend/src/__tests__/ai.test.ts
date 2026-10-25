import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { buildScanPrompt, completeText, extractReceiptItems } from '../lib/ai.js'

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('buildScanPrompt', () => {
  it('returns a prompt string', () => {
    const prompt = buildScanPrompt()
    expect(prompt).toContain('receipt OCR')
    expect(prompt).toContain('JSON')
  })
})

describe('completeText', () => {
  it('calls OpenAI and returns content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Hello from OpenAI' } }],
      }),
    })
    const result = await completeText('openai', 'sk-test', 'system', 'user')
    expect(result).toBe('Hello from OpenAI')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('calls Gemini and returns content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] } }],
      }),
    })
    const result = await completeText('gemini', 'sk-test', 'system', 'user')
    expect(result).toBe('Hello from Gemini')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com'),
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('calls Anthropic and returns content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: 'Hello from Anthropic' }],
      }),
    })
    const result = await completeText('anthropic', 'sk-test', 'system', 'user')
    expect(result).toBe('Hello from Anthropic')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('calls OpenCode by default and returns content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Hello from OpenCode' } }],
      }),
    })
    const result = await completeText('opencode', 'sk-test', 'system', 'user')
    expect(result).toBe('Hello from OpenCode')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.opencode.ai/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('calls Ollama Cloud with the default vision model', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Hello from Ollama' } }],
      }),
    })
    globalThis.fetch = fetchMock
    const result = await completeText('ollama', 'sk-test', 'system', 'user')
    expect(result).toBe('Hello from Ollama')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ollama.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('qwen3-vl:235b-instruct')
  })

  it('calls a custom OpenAI-compatible provider with base URL and model', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Hello from custom' } }],
      }),
    })
    globalThis.fetch = fetchMock
    const result = await completeText('custom', 'sk-test', 'system', 'user', {
      baseUrl: 'https://api.example.com/v1',
      model: 'llama3.3:70b',
    })
    expect(result).toBe('Hello from custom')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('llama3.3:70b')
  })

  it('throws when custom provider has no base URL or model', async () => {
    await expect(completeText('custom', 'sk-test', 'system', 'user')).rejects.toThrow(
      'requires a base URL and model'
    )
  })

  it('throws on unsupported provider', async () => {
    await expect(completeText('unknown', 'sk-test', 'system', 'user')).rejects.toThrow(
      'Unsupported AI provider'
    )
  })

  it('throws when provider returns empty content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    })
    await expect(completeText('openai', 'sk-test', 'system', 'user')).rejects.toThrow(
      'OpenAI returned empty response'
    )
  })

  it('throws when provider request fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })
    await expect(completeText('openai', 'sk-test', 'system', 'user')).rejects.toThrow('401')
  })
})

describe('extractReceiptItems', () => {
  it('parses Gemini receipt JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    store_name: 'Indomaret',
                    date: '2026-07-26',
                    items: [{ name: 'Milk', qty: 1, unit: 'L', price: 18500 }],
                  }),
                },
              ],
            },
          },
        ],
      }),
    })
    const result = await extractReceiptItems(new ArrayBuffer(8), 'image/jpeg', 'gemini', 'sk-test')
    expect(result.store_name).toBe('Indomaret')
    expect(result.items[0].name).toBe('Milk')
    expect(result.items[0].price).toBe(18500)
  })

  it('throws when AI response has no JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'no json here' }] } }],
      }),
    })
    await expect(
      extractReceiptItems(new ArrayBuffer(8), 'image/jpeg', 'gemini', 'sk-test')
    ).rejects.toThrow('AI response did not contain valid JSON')
  })

  it('throws when AI request fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Server error',
    })
    await expect(
      extractReceiptItems(new ArrayBuffer(8), 'image/jpeg', 'gemini', 'sk-test')
    ).rejects.toThrow()
  })
})
