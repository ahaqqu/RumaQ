import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import openapi from '../../openapi.json'
import {
  DEFAULT_PERSONA,
  PERSONA_KEY,
  PERSONA_COPY_KEYS,
  loadPersona,
  savePersona,
  personaText,
  deriveHue,
  speak,
  buildSystemPrompt,
  applyTheme,
  buildPersonaCopyRequest,
  generatePersonaCopy,
} from './persona.js'
import { generateAiPersonaCopy } from './api'
import { i18n } from '../i18n/index.js'

// The browser has no provider client any more (#523 P5): persona.js delegates
// the rewrite to POST /api/ai/generate/persona, so this suite mocks the API
// client rather than `fetch` to a vendor.
vi.mock('./api', () => ({ generateAiPersonaCopy: vi.fn() }))

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

describe('buildPersonaCopyRequest (#523 P5)', () => {
  it('sends the two roles, the language and every built-in slot', () => {
    const request = buildPersonaCopyRequest(
      { enabled: true, userRole: ' raja ', aiRole: 'prajurit' },
      (key) => `copy:${key}`
    )
    expect(request.user_role).toBe('raja')
    expect(request.ai_role).toBe('prajurit')
    expect(request.language).toBe('en')
    expect(Object.keys(request.copy)).toEqual([...PERSONA_COPY_KEYS])
    expect(request.copy.homeLead).toBe('copy:persona.homeLead')
  })

  it('reports the language the copy is written in', () => {
    i18n.changeLanguage('id')
    try {
      expect(buildPersonaCopyRequest({ userRole: 'raja', aiRole: 'prajurit' }).language).toBe('id')
    } finally {
      i18n.changeLanguage('en')
    }
  })

  it('carries no provider, endpoint, model or key field', () => {
    // The browser lost provider access in P5: the request is roles + copy only.
    const request = buildPersonaCopyRequest({ userRole: 'raja', aiRole: 'prajurit' })
    expect(Object.keys(request).sort()).toEqual(['ai_role', 'copy', 'language', 'user_role'])
    expect(JSON.stringify(request)).not.toMatch(/sk-|api.openai|generativelanguage|anthropic/)
  })
})

describe('the persona request contract (#523 P5)', () => {
  // The generated spec is the SERVER's contract (CI regenerates it from the
  // routed API). Pinning the UI's slot list to it is what keeps the frontend
  // from sending a key the backend would 400 on — the drift `aiProviders.js`
  // used to carry, now a test.
  const operation = openapi.paths['/api/ai/generate/persona'].post
  const bodySchema = operation.requestBody.content['application/json'].schema

  it('accepts exactly the slots this module generates', () => {
    expect(Object.keys(bodySchema.properties.copy.properties).sort()).toEqual(
      [...PERSONA_COPY_KEYS].sort()
    )
  })

  it('is roles + copy only — no provider, model or key reaches the browser API', () => {
    expect(Object.keys(bodySchema.properties).sort()).toEqual([
      'ai_role',
      'copy',
      'language',
      'user_role',
    ])
  })
})

describe('generatePersonaCopy (#523 P5)', () => {
  it('returns null without calling the API when the persona is off or incomplete', async () => {
    for (const persona of [
      DEFAULT_PERSONA,
      { enabled: false, userRole: 'raja', aiRole: 'prajurit' },
      { enabled: true, userRole: '', aiRole: 'prajurit' },
      { enabled: true, userRole: 'raja', aiRole: '' },
    ]) {
      expect(await generatePersonaCopy(persona, idT)).toBeNull()
    }
    expect(generateAiPersonaCopy).not.toHaveBeenCalled()
  })

  it('delegates to the server route and returns the rewritten slots', async () => {
    generateAiPersonaCopy.mockResolvedValue({ copy: { homeLead: 'Sire, the kitchen is calm.' } })
    const persona = { enabled: true, userRole: 'raja', aiRole: 'prajurit' }

    const result = await generatePersonaCopy(persona, idT)

    expect(result).toEqual({ homeLead: 'Sire, the kitchen is calm.' })
    expect(generateAiPersonaCopy).toHaveBeenCalledTimes(1)
    expect(generateAiPersonaCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        user_role: 'raja',
        ai_role: 'prajurit',
        copy: expect.objectContaining({ homeLead: idT('persona.homeLead') }),
      })
    )
  })

  it('lets the failure reach the caller (Settings 402/502 handling)', async () => {
    const err = Object.assign(new Error('AI provider not configured'), { status: 402 })
    generateAiPersonaCopy.mockRejectedValue(err)
    await expect(
      generatePersonaCopy({ enabled: true, userRole: 'raja', aiRole: 'prajurit' }, idT)
    ).rejects.toBe(err)
  })
})
