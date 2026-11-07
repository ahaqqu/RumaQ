import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { resetRateLimit } from '../lib/rate-limit.js'
import {
  isExpiryOcrSupported,
  normalizeExpirySuggestion,
  runExpiryOcr,
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
// The #523 P1 resolver: one join per capability, keyed by the HOUSEHOLD.
const CAPABILITY_ROUTE = /FROM ai_capabilities c/

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

// One assigned provider row, shaped exactly like the resolver's join (the
// route function receives the bound params: [household_id, capability]).
function capabilityRow(encryptedKey: string | null, overrides: Row = {}): Row {
  return {
    capability: 'vision',
    model: null,
    thinking_level: null,
    provider_id: 'p-1',
    kind: 'openai-compatible',
    preset: 'openai',
    base_url: null,
    // The vision assignment inherits this when the capability has no model of
    // its own (#523's capability.model ?? provider.default_model rule).
    default_model: 'vision-model',
    encrypted_key: encryptedKey,
    ...overrides,
  }
}

// The scoped lookups + the settings household read + the capability join every
// OCR request runs. The VISION assignment is the only one seeded: the OCR path
// resolves the household's vision capability (P1's single access still serves
// it), so a null row means "no AI configured" (402).
function householdAiRoutes(
  encryptedKey: string | null,
  overrides: Row = {}
): [RegExp, (params: unknown[]) => Row | null][] {
  return [
    [DOC_ROW_ROUTE, () => DOC_ROW()],
    [FILE_ROW_ROUTE, () => FILE_ROW()],
    [SETTINGS_ROUTE, () => ({ household_id: 'h1' })],
    [
      CAPABILITY_ROUTE,
      (params) => (params[1] === 'vision' ? capabilityRow(encryptedKey, overrides) : null),
    ],
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

  it('passes a real calendar date through and JSON null for "no date found"', () => {
    expect(normalizeExpirySuggestion('2027-06-05')).toBe('2027-06-05')
    expect(normalizeExpirySuggestion(null)).toBeNull()
    // JSON null is the ONLY "no date found" (review T4-A3): a missing key
    // (undefined — an off-schema answer like `{"expiry_date": ...}` or `{}`)
    // is a rejection, not a silent "no date".
    expect(() => normalizeExpirySuggestion(undefined)).toThrow(DocumentOcrError)
  })

  it('rejects garbage answers instead of guessing (wrong type, wrong shape, non-calendar)', () => {
    for (const bad of [5, '05-06-2027', '2026-02-31', '2027-6-5', '']) {
      expect(() => normalizeExpirySuggestion(bad)).toThrow(DocumentOcrError)
    }
  })

  // The audit invariant lives ONCE in runExpiryOcr (review T4-B2) — testable
  // here without HTTP: the usage event + outcome line land on every path
  // that reaches the provider decision, exactly once.
  describe('runExpiryOcr audit pairing', () => {
    const access = {
      provider: 'openai',
      apiKey: 'sk-user-secret',
      baseUrl: null,
      model: null,
      visionModel: 'vision-model',
      thinkingLevel: null,
      keySource: 'user' as const,
      call: {
        capability: 'vision' as const,
        householdId: 'h1',
        providerKind: 'openai-compatible' as const,
        providerId: 'p-1',
        model: 'vision-model',
        funding: 'household' as const,
      },
    }
    const args = {
      access,
      imageBytes: new ArrayBuffer(8),
      contentType: 'image/jpeg',
      userId: 'u1',
      householdId: 'h1',
      documentId: 'doc-1',
      fileId: 'file-1',
    }

    function fakeEnv(testMode: string) {
      const runs: Array<{ sql: string; params: unknown[] }> = []
      const env = {
        DB: {
          prepare: (sql: string) => ({
            bind: (...params: unknown[]) => ({
              run: async () => {
                runs.push({ sql, params })
              },
            }),
          }),
        },
        TEST_MODE: testMode,
      }
      return { env: env as unknown as Parameters<typeof runExpiryOcr>[0], runs }
    }

    it('writes the usage event + outcome line exactly once on the success path', async () => {
      const { env, runs } = fakeEnv('true')
      const { suggestion, outcome } = await runExpiryOcr(env, args)
      expect(suggestion).toBe('2027-06-05')
      expect(outcome).toBe('suggested')
      expect(runs).toHaveLength(1)
      expect(runs[0].sql).toContain('INSERT INTO ai_usage_events')
      // provider(kind), model, capability, household_id, funding bind at 4..8.
      expect(runs[0].params[4]).toBe('openai-compatible')
      expect(runs[0].params[5]).toBe('vision-model')
      expect(runs[0].params[6]).toBe('vision')
      expect(runs[0].params[7]).toBe('h1')
      expect(runs[0].params[8]).toBe('household')
    })

    it('stamps the row with the VISION capability even when the bridge primary is reasoning', async () => {
      // A backfilled household has all three assignments, so the P1 bridge
      // resolves 'reasoning' first (ai-access.ts PRIMARY_CAPABILITIES) and the
      // access it hands OCR carries that capability. The usage row must name
      // the capability the FEATURE is, not the one the bridge happened to pick
      // (thermos A5) — otherwise the new ai_usage_events.capability dimension
      // records every vault OCR call as reasoning spend.
      const { env, runs } = fakeEnv('true')
      const viaReasoning = {
        ...access,
        call: { ...access.call, capability: 'reasoning' as const, model: 'text-model' },
      }
      await runExpiryOcr(env, { ...args, access: viaReasoning })
      expect(runs[0]?.params[5]).toBe('vision-model')
      expect(runs[0]?.params[6]).toBe('vision')
    })

    it('still pairs the audit exactly once when the provider fails, then rethrows', async () => {
      const { env, runs } = fakeEnv('false')
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('socket hung up'))
      try {
        await expect(runExpiryOcr(env, args)).rejects.toThrow('socket hung up')
      } finally {
        vi.restoreAllMocks()
      }
      expect(runs).toHaveLength(1)
      expect(runs[0].sql).toContain('INSERT INTO ai_usage_events')
    })

    it('still pairs the audit exactly once when the answer fails validation', async () => {
      const { env, runs } = fakeEnv('false')
      globalThis.fetch = vi.fn().mockResolvedValue(openAiAnswer('{"expires_on": "2026-02-31"}'))
      try {
        await expect(runExpiryOcr(env, args)).rejects.toThrow(DocumentOcrError)
      } finally {
        vi.restoreAllMocks()
      }
      expect(runs).toHaveLength(1)
      expect(runs[0].sql).toContain('INSERT INTO ai_usage_events')
    })
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

  it('answers 402 when the household has no AI configured (no server fallback any more)', async () => {
    const { env, app } = h.setup(householdAiRoutes(null))
    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/not configured/i)
  })

  it('suggests a date through the household provider in TEST_MODE and records the attempt', async () => {
    const encrypted = await encryptAiKey('sk-household', ENV_KEY)
    const { db, env, bucket, app } = h.setup(
      householdAiRoutes(encrypted, { model: 'vision-model' })
    )
    seedBucket(bucket, JPEG_BYTES, 'image/jpeg')

    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { expires_on: string | null; model: string | null }
    expect(body.expires_on).toBe('2027-06-05')
    expect(body.model).toBe('vision-model')

    const event = db.log.find((entry) => /INSERT INTO ai_usage_events/.test(entry.sql))
    expect(event).toBeTruthy()
    // id, user_id, ts, date, provider(kind), model, capability, household, funding, tokens…
    expect(event?.params[4]).toBe('openai-compatible')
    expect(event?.params[5]).toBe('vision-model')
    expect(event?.params[6]).toBe('vision')
    expect(event?.params[7]).toBe('h1')
    expect(event?.params[8]).toBe('household')
  })

  it('calls the USER provider with the user vision model and never logs the key', async () => {
    const encrypted = await encryptAiKey('sk-user-secret', ENV_KEY)
    const { db, env, bucket, app } = h.setup(
      householdAiRoutes(encrypted, { model: 'vision-model' }),
      [],
      {
        envOverrides: { TEST_MODE: 'false', WORKER_ENCRYPTION_KEY: ENV_KEY } as Partial<MockEnv>,
      }
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
    const { db, env, bucket, app } = h.setup(householdAiRoutes(encrypted), [], {
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

    // The byte READ itself is durably audited even though the call failed —
    // the document_audit 'ocr' row names the document and the file (T4-A1).
    const audit = db.log.find((entry) => /INSERT INTO document_audit/.test(entry.sql))
    expect(audit).toBeTruthy()
    // Binds: id, document_id, household_id, actor_user_id, action, file_id.
    expect(audit?.params[1]).toBe('doc-1')
    expect(audit?.params[2]).toBe('h1')
    expect(audit?.params[3]).toBe('u1')
    expect(audit?.params[4]).toBe('ocr')
    expect(audit?.params[5]).toBe('file-1')
  })

  it('rejects a well-formed non-calendar model answer with 502 (outcome=rejected)', async () => {
    const encrypted = await encryptAiKey('sk-user-secret', ENV_KEY)
    const { env, bucket, app } = h.setup(householdAiRoutes(encrypted), [], {
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
    const { db, env, bucket, app } = h.setup(householdAiRoutes(encrypted), [], {
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

  it('rejects an OFF-SCHEMA answer (missing expires_on key) with 502 — only JSON null means "no date found"', async () => {
    // Review T4-A3: `{"expiry_date": ...}` / `{}` used to masquerade as a
    // legitimate "no expiry" 200; the module contract says wrong shape =
    // rejection.
    const encrypted = await encryptAiKey('sk-user-secret', ENV_KEY)
    const { env, bucket, app } = h.setup(householdAiRoutes(encrypted), [], {
      envOverrides: { TEST_MODE: 'false', WORKER_ENCRYPTION_KEY: ENV_KEY } as Partial<MockEnv>,
    })
    seedBucket(bucket, JPEG_BYTES, 'image/jpeg')

    globalThis.fetch = vi.fn().mockResolvedValue(openAiAnswer('{"expiry_date": "2027-06-05"}'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/could not read an expiry date/i)
    const logText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logText).toContain('outcome=rejected')
  })

  it('audits the byte read as a durable document_audit ocr row on the success path (T4-A1)', async () => {
    const encrypted = await encryptAiKey('sk-household', ENV_KEY)
    const { db, env, bucket, app } = h.setup(householdAiRoutes(encrypted))
    seedBucket(bucket, JPEG_BYTES, 'image/jpeg')

    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(200)

    const audit = db.log.find((entry) => /INSERT INTO document_audit/.test(entry.sql))
    expect(audit).toBeTruthy()
    // Binds: id, document_id, household_id, actor_user_id, action, file_id.
    expect(audit?.params[1]).toBe('doc-1')
    expect(audit?.params[2]).toBe('h1')
    expect(audit?.params[3]).toBe('u1')
    expect(audit?.params[4]).toBe('ocr')
    expect(audit?.params[5]).toBe('file-1')
  })

  it('leaves no document_audit row on the pre-read rejections (404/415/402/429 audit nothing)', async () => {
    // The T4-A5 boundary: pre-provider rejections (no read, no billing) keep
    // the empty-audit posture of every other vault route.
    const { db, env, app } = h.setup(householdAiRoutes(null))
    const res = await app.request(OCR_PATH, { method: 'POST' }, env)
    expect(res.status).toBe(402)
    expect(db.log.some((entry) => /INSERT INTO document_audit/.test(entry.sql))).toBe(false)
  })

  it('rate-limits bursts of read-date calls per user', async () => {
    const encrypted = await encryptAiKey('sk-household', ENV_KEY)
    const { env, app } = h.setup(householdAiRoutes(encrypted))

    // OCR_RATE_MAX is 30/min; the 31st call in the window is refused.
    let last: Response | undefined
    for (let i = 0; i < 31; i++) {
      last = await app.request(OCR_PATH, { method: 'POST' }, env)
    }
    expect(last?.status).toBe(429)
  })
})
