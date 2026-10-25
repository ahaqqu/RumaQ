export type ParsedItem = {
  name: string
  qty: number
  unit: string
  price: number
  total?: number
}

export type ScanResult = {
  store_name?: string
  date?: string
  items: ParsedItem[]
}

export type PlanItem = {
  name: string
  qty: number
  unit: string
  store_id: string | null
  price_estimate: number | null
  why: string
}

export type PlanResult = {
  items: PlanItem[]
}

export function buildScanPrompt(): string {
  return `You are a receipt OCR assistant. Extract line items from the receipt image.

Return ONLY valid JSON in this exact format:
{
  "store_name": "Name of store (if visible)",
  "date": "Purchase date in YYYY-MM-DD format (if visible)",
  "items": [
    { "name": "Item name", "qty": 1, "unit": "pcs", "price": 10000 }
  ]
}

Rules:
- Extract every item line from the receipt.
- qty must be a number (default 1 if not specified).
- unit should be the unit of measurement (pcs, kg, L, pack, etc).
- price is the unit price or line total in the local currency (integer).
- Omit subtotals, taxes, and total lines.
- If you cannot read the receipt clearly, return { "items": [] }.
- Do NOT include any text outside the JSON.`
}

type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | ChatContentPart[]
}

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
      }>
    }
  }>
}

type AnthropicResponse = {
  content?: Array<{
    text?: string
  }>
}

export type AiCallOpts = {
  baseUrl?: string | null
  model?: string | null
}

const OLLAMA_BASE_URL = 'https://ollama.com/v1'
const OLLAMA_DEFAULT_MODEL = 'qwen3-vl:235b-instruct'

async function callOpenAICompatible(
  providerLabel: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[]
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 2000,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${providerLabel} request failed: ${res.status} ${body}`)
  }

  const data = (await res.json()) as OpenAIResponse
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error(`${providerLabel} returned empty response`)

  return content
}

async function callOpenAI(apiKey: string, messages: ChatMessage[]): Promise<string> {
  return callOpenAICompatible(
    'OpenAI',
    'https://api.openai.com/v1',
    'gpt-4o-mini',
    apiKey,
    messages
  )
}

async function callGemini(apiKey: string, messages: ChatMessage[]): Promise<string> {
  const systemMsg = messages.find((m) => m.role === 'system')
  const userMsg = messages.find((m) => m.role === 'user')

  const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = []

  if (systemMsg) {
    parts.push({
      text: typeof systemMsg.content === 'string' ? systemMsg.content : '',
    })
  }
  if (userMsg) {
    if (typeof userMsg.content === 'string') {
      parts.push({ text: userMsg.content })
    } else if (Array.isArray(userMsg.content)) {
      for (const part of userMsg.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text })
        } else if (part.type === 'image_url') {
          const url = part.image_url.url
          parts.push({
            inline_data: {
              mime_type: url.startsWith('data:')
                ? url.split(';')[0].replace('data:', '')
                : 'image/jpeg',
              data: url.startsWith('data:') ? url.split(',')[1] : url,
            },
          })
        }
      }
    }
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Gemini request failed: ${res.status} ${body}`)
  }

  const data = (await res.json()) as GeminiResponse
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!content) throw new Error('Gemini returned empty response')

  return content
}

async function callAnthropic(apiKey: string, messages: ChatMessage[]): Promise<string> {
  const systemMsg = messages.find((m) => m.role === 'system')
  const chatMessages = messages.filter((m) => m.role !== 'system')

  const body: Record<string, unknown> = {
    model: 'claude-3-haiku-20240307',
    max_tokens: 2000,
    messages: chatMessages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content.map((part) => {
              if (part.type === 'text') return { type: 'text', text: part.text }
              const url = part.image_url.url
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: url.startsWith('data:')
                    ? url.split(';')[0].replace('data:', '')
                    : 'image/jpeg',
                  data: url.startsWith('data:') ? url.split(',')[1] : url,
                },
              }
            }),
    })),
  }

  if (systemMsg) {
    body.system = typeof systemMsg.content === 'string' ? systemMsg.content : ''
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const bodyText = await res.text()
    throw new Error(`Anthropic request failed: ${res.status} ${bodyText}`)
  }

  const result = (await res.json()) as AnthropicResponse
  const content = result.content?.[0]?.text
  if (!content) throw new Error('Anthropic returned empty response')

  return content
}

async function callOpenCode(apiKey: string, messages: ChatMessage[]): Promise<string> {
  return callOpenAICompatible(
    'OpenCode',
    'https://api.opencode.ai/v1',
    'opencode-vision',
    apiKey,
    messages
  )
}

function parseJsonResponse<T>(content: string): T {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('AI response did not contain valid JSON')
  }

  try {
    return JSON.parse(jsonMatch[0]) as T
  } catch {
    throw new Error('Failed to parse AI response JSON')
  }
}

function toDataUri(imageData: ArrayBuffer, type: string): string {
  const base64 = arrayBufferToBase64(imageData)
  return `data:${type};base64,${base64}`
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

async function callProvider(
  provider: string,
  apiKey: string,
  messages: ChatMessage[],
  opts?: AiCallOpts
): Promise<string> {
  switch (provider) {
    case 'openai':
      return callOpenAI(apiKey, messages)
    case 'gemini':
      return callGemini(apiKey, messages)
    case 'anthropic':
      return callAnthropic(apiKey, messages)
    case 'opencode':
      return callOpenCode(apiKey, messages)
    case 'ollama':
      return callOpenAICompatible(
        'Ollama Cloud',
        OLLAMA_BASE_URL,
        opts?.model || OLLAMA_DEFAULT_MODEL,
        apiKey,
        messages
      )
    case 'custom': {
      const baseUrl = opts?.baseUrl?.trim()
      const model = opts?.model?.trim()
      if (!baseUrl || !model) {
        throw new Error('Custom provider requires a base URL and model in Settings')
      }
      return callOpenAICompatible('Custom provider', baseUrl, model, apiKey, messages)
    }
    default:
      throw new Error(`Unsupported AI provider: ${provider}`)
  }
}

export async function completeText(
  provider: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  opts?: AiCallOpts
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
  return callProvider(provider, apiKey, messages, opts)
}

export async function extractReceiptItems(
  imageBuffer: ArrayBuffer,
  imageType: string,
  provider: string,
  apiKey: string,
  opts?: AiCallOpts
): Promise<ScanResult> {
  const imageData = toDataUri(imageBuffer, imageType)

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: buildScanPrompt() },
        { type: 'image_url', image_url: { url: imageData } },
      ],
    },
  ]

  const content = await callProvider(provider, apiKey, messages, opts)
  const result = parseJsonResponse<ScanResult>(content)

  const items: ParsedItem[] = ((result.items || []) as Record<string, unknown>[]).map((it) => ({
    name: String(it.name || ''),
    qty: Number(it.qty) || 1,
    unit: String(it.unit || 'pcs'),
    price: Math.round(Number(it.price) || 0),
    total: it.total ? Math.round(Number(it.total)) : undefined,
  }))

  return {
    store_name: result.store_name ? String(result.store_name) : undefined,
    date: result.date ? String(result.date) : undefined,
    items,
  }
}
