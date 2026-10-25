import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import {
  DEFAULT_PERSONA,
  PERSONA_KEY,
  loadPersona,
  savePersona,
  personaText,
  deriveHue,
  speak,
  buildSystemPrompt,
  applyTheme,
  generatePersonaCopy,
} from './persona.js'

const ID_TEMPLATES = {
  'persona.homeLead':
    'Stok terpantau otomatis dari struk belanja. Sisa dihitung dari kebiasaanmu, bukan diisi manual.',
  'persona.systemPrompt':
    'Kamu adalah asisten inventaris dan belanja rumah tangga bernama RumaQ. Jawab dengan jelas, singkat, dan praktis.',
  'persona.roleInstructionBase':
    'Bayangkan kamu adalah {{ai}} dan pengguna adalah {{user}}. Seluruh jawabanmu harus sesuai peran tersebut.',
}

function idT(key, opts) {
  let template = ID_TEMPLATES[key]
  if (!template) return key
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      template = template.replace(`{{${k}}}`, v)
    }
  }
  return template
}

beforeEach(() => {
  localStorage.clear()
})

describe('loadPersona / savePersona', () => {
  it('returns DEFAULT_PERSONA when nothing is stored', () => {
    expect(loadPersona()).toEqual(DEFAULT_PERSONA)
  })

  it('round-trips a persona', () => {
    const p = {
      enabled: true,
      userRole: 'raja',
      aiRole: 'prajurit',
      hue: 270,
      generatedCopy: null,
    }
    savePersona(p)
    const loaded = loadPersona()
    expect(loaded.userRole).toBe('raja')
    expect(loaded.enabled).toBe(true)
  })

  it('returns DEFAULT_PERSONA on corrupt localStorage', () => {
    localStorage.setItem(PERSONA_KEY, 'not-json')
    expect(loadPersona()).toEqual(DEFAULT_PERSONA)
  })
})

describe('deriveHue', () => {
  it('returns a hue in 0..359 for a given role pair', () => {
    const h = deriveHue('raja', 'prajurit')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(360)
  })

  it('returns same hue for same role pair (deterministic)', () => {
    expect(deriveHue('raja', 'prajurit')).toBe(deriveHue('raja', 'prajurit'))
  })

  it('returns 230 for empty roles', () => {
    expect(deriveHue('', '')).toBe(230)
    expect(deriveHue()).toBe(230)
  })

  it('is case-insensitive', () => {
    expect(deriveHue('RAJA', 'PRAJURIT')).toBe(deriveHue('raja', 'prajurit'))
  })
})

describe('speak', () => {
  it('returns text as-is regardless of persona', () => {
    expect(speak('hello', DEFAULT_PERSONA, idT)).toBe('hello')
    expect(speak('hello', { enabled: true, userRole: 'raja', aiRole: 'prajurit' }, idT)).toBe(
      'hello'
    )
  })
})

describe('personaText', () => {
  it('returns base text when persona is not enabled', () => {
    expect(personaText('homeLead', DEFAULT_PERSONA, idT)).toBe(ID_TEMPLATES['persona.homeLead'])
  })

  it('returns AI-generated copy when available', () => {
    const p = {
      enabled: true,
      userRole: 'raja',
      aiRole: 'prajurit',
      hue: 270,
      generatedCopy: { homeLead: 'AI version' },
    }
    expect(personaText('homeLead', p, idT)).toBe('AI version')
  })

  it('falls back to base text when no AI copy', () => {
    const p = {
      enabled: true,
      userRole: 'raja',
      aiRole: 'prajurit',
      hue: 270,
      generatedCopy: null,
    }
    const result = personaText('homeLead', p, idT)
    expect(result).toBe(ID_TEMPLATES['persona.homeLead'])
  })
})

describe('buildSystemPrompt', () => {
  it('returns base prompt when persona is not enabled', () => {
    const p = buildSystemPrompt(DEFAULT_PERSONA, idT)
    expect(p).toContain('RumaQ')
    expect(p).not.toContain('Bayangkan')
  })

  it('includes role instruction for enabled persona', () => {
    const p = buildSystemPrompt({ enabled: true, userRole: 'raja', aiRole: 'prajurit' }, idT)
    expect(p).toContain('Bayangkan')
    expect(p).toContain('raja')
    expect(p).toContain('prajurit')
  })

  it('includes mood instruction for employee-to-boss mood', () => {
    const p = buildSystemPrompt({ enabled: true, userRole: 'bos', aiRole: 'pegawai' }, idT)
    expect(p).toContain('formal')
  })

  it('does not include mood instruction for generic mood', () => {
    const p = buildSystemPrompt({ enabled: true, userRole: 'tamu', aiRole: 'host' }, idT)
    expect(p).not.toContain('form')
  })

  it('detects servant-to-royal mood', () => {
    const p = buildSystemPrompt({ enabled: true, userRole: 'ratu', aiRole: 'pelayan' }, idT)
    expect(p).toContain('respectful')
  })

  it('detects student-to-teacher mood', () => {
    const p = buildSystemPrompt({ enabled: true, userRole: 'guru', aiRole: 'murid' }, idT)
    expect(p).toContain('polite')
  })

  it('detects medical mood', () => {
    const p = buildSystemPrompt({ enabled: true, userRole: 'dokter', aiRole: 'pasien' }, idT)
    expect(p).toContain('professional')
  })

  it('detects casual mood from AI role', () => {
    const p = buildSystemPrompt({ enabled: true, userRole: 'saya', aiRole: 'teman' }, idT)
    expect(p).toContain('casual')
  })
})

describe('applyTheme', () => {
  it('removes custom properties when persona is disabled', () => {
    const el = { style: { removeProperty: vi.fn() }, dataset: {} }
    applyTheme(DEFAULT_PERSONA, el)
    expect(el.style.removeProperty).toHaveBeenCalled()
    expect(el.dataset.persona).toBe('')
  })

  it('sets custom properties when persona is enabled', () => {
    const el = { style: { setProperty: vi.fn() }, dataset: {} }
    applyTheme({ enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }, el)
    expect(el.style.setProperty).toHaveBeenCalledWith('--accent', expect.any(String))
    expect(el.dataset.persona).toBe('raja|prajurit')
  })

  it('derives hue when persona hue is null', () => {
    const el = { style: { setProperty: vi.fn() }, dataset: {} }
    applyTheme({ enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: null }, el)
    expect(el.style.setProperty).toHaveBeenCalled()
  })

  it('handles persona without enabled field', () => {
    const el = { style: { removeProperty: vi.fn() }, dataset: {} }
    applyTheme(null, el)
    expect(el.style.removeProperty).toHaveBeenCalled()
  })
})

describe('generatePersonaCopy', () => {
  it('returns null when persona is not enabled', async () => {
    const result = await generatePersonaCopy(DEFAULT_PERSONA, 'sk-test', 'opencode', idT)
    expect(result).toBeNull()
  })

  it('returns null when aiKey is missing', async () => {
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit' }
    const result = await generatePersonaCopy(p, null, 'opencode', idT)
    expect(result).toBeNull()
  })

  it('rejects when the AI call fails so the caller can surface the error', async () => {
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit' }
    await expect(generatePersonaCopy(p, 'sk-invalid', 'opencode', idT)).rejects.toThrow()
  })

  it('returns null when AI returns non-JSON', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'not json' }] } }],
      }),
    })
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    const result = await generatePersonaCopy(p, 'sk-valid', 'gemini', idT)
    expect(result).toBeNull()
  })

  it('succeeds with valid Gemini response', async () => {
    const jsonResponse = JSON.stringify({
      homeLead: 'AI home lead',
      inventoryLead: 'AI inventory lead',
      planLeadNoKey: 'AI plan lead no key',
      planLead: 'AI plan lead',
      historyLead: 'AI history lead',
      receiptLead: 'AI receipt lead',
      settingsLead: 'AI settings lead',
      assistantGreeting: 'AI greeting',
      assistantQuestion: 'AI question',
    })
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: jsonResponse }] } }],
      }),
    })
    const p = {
      enabled: true,
      userRole: 'raja',
      aiRole: 'prajurit',
      hue: 270,
      generatedCopy: null,
    }
    const result = await generatePersonaCopy(p, 'sk-valid', 'gemini', idT)
    expect(result).not.toBeNull()
    expect(result.homeLead).toBe('AI home lead')
  })

  it('succeeds with markdown-wrapped JSON', async () => {
    const jsonResponse = '```json\n{"homeLead": "MD lead"}\n```'
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: jsonResponse }] } }],
      }),
    })
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    const result = await generatePersonaCopy(p, 'sk-valid', 'gemini', idT)
    expect(result).not.toBeNull()
    expect(result.homeLead).toBe('MD lead')
  })

  it('generates with openai provider', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"homeLead":"AI"}' } }],
      }),
    })
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    const result = await generatePersonaCopy(p, 'sk-valid', 'openai', idT)
    expect(result).not.toBeNull()
  })

  it('generates with anthropic provider', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ text: '{"homeLead":"AI"}' }] }),
    })
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    const result = await generatePersonaCopy(p, 'sk-valid', 'anthropic', idT)
    expect(result).not.toBeNull()
  })

  it('generates with opencode provider (default)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"homeLead":"AI"}' } }],
      }),
    })
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    const result = await generatePersonaCopy(p, 'sk-valid', 'opencode', idT)
    expect(result).not.toBeNull()
  })

  it('generates with ollama provider', async () => {
    let calledUrl = ''
    globalThis.fetch = async (url) => {
      calledUrl = url
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"homeLead":"AI"}' } }],
        }),
      }
    }
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    const result = await generatePersonaCopy(p, 'sk-valid', 'ollama', idT)
    expect(result).not.toBeNull()
    expect(calledUrl).toContain('https://ollama.com/v1/chat/completions')
  })

  it('generates with custom provider using base URL and model', async () => {
    let calledUrl = ''
    globalThis.fetch = async (url) => {
      calledUrl = url
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"homeLead":"AI"}' } }],
        }),
      }
    }
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    const result = await generatePersonaCopy(p, 'sk-valid', 'custom', idT, {
      baseUrl: 'https://api.example.com/v1',
      model: 'llama3.3:70b',
    })
    expect(result).not.toBeNull()
    expect(calledUrl).toContain('https://api.example.com/v1/chat/completions')
  })

  it('uses the selected model for Ollama when a model option is passed', async () => {
    let calledBody = null
    globalThis.fetch = async (url, init) => {
      calledBody = JSON.parse(init.body)
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"homeLead":"AI"}' } }],
        }),
      }
    }
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    await generatePersonaCopy(p, 'sk-valid', 'ollama', idT, { model: 'llama3.3:70b' })
    expect(calledBody.model).toBe('llama3.3:70b')
  })

  it('throws for custom provider without base URL or model', async () => {
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    await expect(generatePersonaCopy(p, 'sk-valid', 'custom', idT)).rejects.toThrow(
      'requires a base URL and model'
    )
  })

  it('returns null when AI response is empty', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '' }] } }],
      }),
    })
    const p = { enabled: true, userRole: 'raja', aiRole: 'prajurit', hue: 270 }
    const result = await generatePersonaCopy(p, 'sk-valid', 'gemini', idT)
    expect(result).toBeNull()
  })
})
