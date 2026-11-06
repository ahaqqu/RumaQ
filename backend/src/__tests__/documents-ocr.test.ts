import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { resetRateLimit } from '../lib/rate-limit.js'
import {
  isExpiryOcrSupported,
  normalizeExpirySuggestion,
  DocumentOcrError,
  logExpiryOcrOutcome,
} from '../lib/document-ocr.js'
import { encryptAiKey } from '../lib/crypto.js'
import {
  createDocumentsHarness,
  createEnv,
  DOC_ROW,
  DOC_ROW_ROUTE,
  FILE_ROW,
  FILE_ROW_ROUTE,
  JPEG_BYTES,
  PNG_BYTES,
  type Row,
} from './support/documents-harness.js'
import type { MockEnv } from './support/env.js'

// The vault expiry-OCR surface (ahaqqu/RumaQ#433): POST
// /api/documents/:id/files/:fileId/extract-expiry. Same idiom as the sibling
// files — the fake D1 routes on SQL fragments and the real StorageAdapter
// over the in-memory R2 stub — plus a mocked global fetch standing in for the
// USER'S OWN provider. The extraction never writes metadata: the response is
// a suggestion the expiry editor prefills, and every attempt (failures
// included) records an ai_usage_events row + an outcome log line with NO
// document content and NO key material.

const OCR_PATH = '/api/documents/doc-1/files/file-1/extract-expiry'

const SETTINGS_ROUTE = /FROM user_settings WHERE user_id/

function serverAiEnv(overrides: Record<string, unknown> = {}) {
  return {
    RUMAQ_SERVER_AI_PROVIDER: 'gemini',
    RUMAQ_SERVER_AI_KEY: 'sk-server',
    RUMAQ_SERVER_AI_MODEL: 'server-model',
    ...overrides,
  }
}

// A provider answer shaped like the OpenAI-compatible chat response.
function openAiAnswer(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }),
    text: async () => '',
  }
}

function userSettingsRow(encryptedKey: string, overrides: Row = {}): Row {
  return {
    ai_provider: 'openai',
    ai_base_url: null,
    ai_model: null,
    ai_vision_model: null,
    ai_thinking_level: null,
    encrypted_ai_key: encryptedKey,
    ...overrides,
  }
}

// The scoped lookups + the settings SELECT every OCR request runs. `settings`
// returning an empty row means "no AI configured" (402) unless the env adds
// the server fallback.
function userKeyRoutes(settings: Row): [RegExp, (params: unknown[]) => Row | null][] {
  return [
    [DOC_ROW_ROUTE, () => DOC_ROW()],
    [FILE_ROW_ROUTE, () => FILE_ROW()],
    [SETTINGS_ROUTE, () => settings],
  ]
}

// The in-memory R2 stub's objects map (optional metadata, per the stub type).
type BucketStub = {
  objects: Map<string, { bytes: Uint8Array; httpMetadata?: { contentType?: string } }>
}

function seedBucket(bucket: BucketStub, bytes: Uint8Array, contentType: string) {
  bucket.objects.set('documents/h1/doc-1/file-1', {
    bytes,
    httpMetadata: { contentType },
  })
}

// lib units ---------------------------------------------------------------

describe('document-ocr lib (issue #433)', () => {
  it('accepts only the vault image types for the vision call', () => {
    expect(isExpiryOcrSupported('image/jpeg')).toBe(true)
    expect(isExpiryOcrSupported('image/png')).toBe(true)
    expect(isExpiryOcrSupported('image/webp')).toBe(true)
    // A legit vault type, but not vision-readable — the route refuses it.
    expect(isExpiryOcrSupported('application/pdf')).toBe(false)
  })

  it('passes a real calendar date through and null for "no date found"', () => {
    expect(normalizeExpirySuggestion('2027-06-05')).toBe('2027-06-05')
    expect(normalizeExpirySuggestion(null)).toBeNull()
    expect(normalizeExpirySuggestion(undefined)).toBeNull()
  })

  it('rejects garbage answers instead of guessing (wrong type, wrong shape, non-calendar)', () => {
    for (const bad of [5, '05-06-2027', '2026-02-31', '2027-6-5', '']) {
      expect(() => normalizeExpirySuggestion(bad)).toThrow(DocumentOcrError)
    }
  })

  it('logs model + outcome only — never document content', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logExpiryOcrOutcome({
      householdId: 'h1',
      documentId: 'doc-1',
      fileId: 'file-1',
      model: 'vision-model',
      outcome: 'suggested',
    })
    const line = String(spy.mock.calls[0]?.[0])
    expect(line).toContain('model=vision-model')
    expect(line).toContain('outcome=suggested')
    expect(line).not.toMatch(/akta|ktp|paspor/i)
    spy.mockRestore()
  })
})

// route -------------------------------------------------------------------

describe('documents routes — expiry OCR (#433)', () => {
  const h = createDocumentsHarness()
  const ENV_KEY = 'test-enc-key'

  beforeEach(() => {
    resetRateLimit()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('401s without a session', async () => {
    const { db, app } = h.setup()
    const unauth = await app.request(
      OCR_PATH,
      { method: 'POST' },
      createEnv(db, { props: undefined })
    )
    expect(unauth.status).toBe(401)
  })

  it('answers 404 for a foreign household document before anything else runs', async () => {
    const { db, env, app } = h.setup([[DOC_ROW_ROUTE, () => null]])
    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(404)
    expect(db.log).toHaveLength(0)
  })

  it('answers 404 when the file does not belong to the document', async () => {
    const { env, app } = h.setup([
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      [FILE_ROW_ROUTE, () => null],
    ])
    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(404)
  })

  it('refuses a PDF with 415 — the vision call reads pixels, not documents', async () => {
    const { env, app } = h.setup([
      [DOC_ROW_ROUTE, () => DOC_ROW()],
      [FILE_ROW_ROUTE, () => FILE_ROW({ content_type: 'application/pdf' })],
      [SETTINGS_ROUTE, () => ({})],
    ])
    // A PDF never reaches the AI settings: refuse on the stored mime first.
    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(415)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/image file/i)
  })

  it('answers 402 when neither the user nor the server has AI configured', async () => {
    const { env, app } = h.setup(userKeyRoutes({}))
    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/not configured/i)
  })

  it('suggests a date via the server fallback in TEST_MODE and records the attempt with the server model', async () => {
    const { db, env, bucket, app } = h.setup(userKeyRoutes({}))
    Object.assign(env, serverAiEnv())
    seedBucket(bucket, JPEG_BYTES, 'image/jpeg')

    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { expires_on: string | null; model: string | null }
    expect(body.expires_on).toBe('2027-06-05')
    // The SERVER's model answered — the server's model name is only ever
    // mixed into a SERVER-keyed call, which this is (no user settings).
    expect(body.model).toBe('server-model')

    const event = db.log.find((entry) => /INSERT INTO ai_usage_events/.test(entry.sql))
    expect(event).toBeTruthy()
    // The INSERT binds id, user_id, ts, date, provider, model, tokens…,
    // key_source — provider/model/key_source are positions 4, 5, 9.
    expect(event?.params[4]).toBe('gemini')
    expect(event?.params[5]).toBe('server-model')
    expect(event?.params[9]).toBe('server')
  })

  it('calls the USER provider with the user vision model and never logs the key', async () => {
    const encrypted = await encryptAiKey('sk-user-secret', ENV_KEY)
    const { db, env, bucket, app } = h.setup(
      userKeyRoutes(userSettingsRow(encrypted, { ai_vision_model: 'vision-model' })),
      [],
      { envOverrides: { TEST_MODE: 'false', WORKER_ENCRYPTION_KEY: ENV_KEY } as Partial<MockEnv> }
    )
    seedBucket(bucket, JPEG_BYTES, 'image/jpeg')

    const fetchMock = vi.fn().mockResolvedValue(openAiAnswer('{"expires_on": "2027-06-05"}'))
    globalThis.fetch = fetchMock
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { expires_on: string | null; model: string | null }
    expect(body).toEqual({ expires_on: '2027-06-05', model: 'vision-model' })

    // The vision model rode the request; the key rode ONLY the header.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('api.openai.com/v1/chat/completions')
    const sentBody = JSON.parse(String(init.body)) as {
      model: string
      messages: Array<{ content: Array<{ type: string }> }>
    }
    expect(sentBody.model).toBe('vision-model')
    expect(sentBody.messages[0]?.content.some((part) => part.type === 'image_url')).toBe(true)
    const sentHeaders = init.headers as Record<string, string>
    expect(sentHeaders?.['Authorization']).toBe('Bearer sk-user-secret')

    // Audit: model + outcome in the log line; the key in NEITHER the log
    // line NOR the usage event row.
    const logText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logText).toContain('model=vision-model')
    expect(logText).toContain('outcome=suggested')
    expect(logText).not.toContain('sk-user-secret')
    const event = db.log.find((entry) => /INSERT INTO ai_usage_events/.test(entry.sql))
    expect(event?.params[5]).toBe('vision-model')
    expect(JSON.stringify(event?.params)).not.toContain('sk-user-secret')
  })

  it('returns 502 and still records usage when the provider fails (outcome=failed)', async () => {
    const encrypted = await encryptAiKey('sk-user-secret', ENV_KEY)
    const { db, env, bucket, app } = h.setup(userKeyRoutes(userSettingsRow(encrypted)), [], {
      envOverrides: { TEST_MODE: 'false', WORKER_ENCRYPTION_KEY: ENV_KEY } as Partial<MockEnv>,
    })
    seedBucket(bucket, JPEG_BYTES, 'image/jpeg')

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'provider exploded',
      json: async () => ({}),
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('AI extraction failed')

    // The provider billed the attempt's input tokens; the event still lands.
    const event = db.log.find((entry) => /INSERT INTO ai_usage_events/.test(entry.sql))
    expect(event).toBeTruthy()
    const logText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logText).toContain('outcome=failed')
    expect(logText).not.toContain('sk-user-secret')
  })

  it('rejects a well-formed non-calendar model answer with 502 (outcome=rejected)', async () => {
    const encrypted = await encryptAiKey('sk-user-secret', ENV_KEY)
    const { env, bucket, app } = h.setup(userKeyRoutes(userSettingsRow(encrypted)), [], {
      envOverrides: { TEST_MODE: 'false', WORKER_ENCRYPTION_KEY: ENV_KEY } as Partial<MockEnv>,
    })
    seedBucket(bucket, PNG_BYTES, 'image/png')

    globalThis.fetch = vi.fn().mockResolvedValue(openAiAnswer('{"expires_on": "2026-02-31"}'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/could not read an expiry date/i)
    const logText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logText).toContain('outcome=rejected')
  })

  it('accepts a null model answer as "no date found" (200, outcome=no_date)', async () => {
    const encrypted = await encryptAiKey('sk-user-secret', ENV_KEY)
    const { db, env, bucket, app } = h.setup(userKeyRoutes(userSettingsRow(encrypted)), [], {
      envOverrides: { TEST_MODE: 'false', WORKER_ENCRYPTION_KEY: ENV_KEY } as Partial<MockEnv>,
    })
    seedBucket(bucket, JPEG_BYTES, 'image/jpeg')

    globalThis.fetch = vi.fn().mockResolvedValue(openAiAnswer('{"expires_on": null}'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { expires_on: string | null }
    expect(body.expires_on).toBeNull()
    const logText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logText).toContain('outcome=no_date')
    // A KTP-style "no expiry" still consumed a provider call — event recorded.
    expect(db.log.some((entry) => /INSERT INTO ai_usage_events/.test(entry.sql))).toBe(true)
  })

  it('rate-limits bursts of read-date calls per user', async () => {
    const { env, app } = h.setup(userKeyRoutes({}))
    Object.assign(env, serverAiEnv())

    // OCR_RATE_MAX is 30/min; the 31st call in the window is refused.
    let last: Response | undefined
    for (let i = 0; i < 31; i++) {
      last = await app.request(OCR_PATH, { method: 'POST' }, env)
    }
    expect(last?.status).toBe(429)
  })
})
