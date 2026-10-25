import { i18n } from '../i18n/index.js'

export const PERSONA_KEY = 'rumaq:persona'

export const DEFAULT_PERSONA = {
  enabled: false,
  userRole: '',
  aiRole: '',
  hue: 230,
  generatedCopy: null,
}

export function loadPersona() {
  try {
    const raw = localStorage.getItem(PERSONA_KEY)
    if (!raw) return DEFAULT_PERSONA
    const parsed = JSON.parse(raw)
    return {
      ...DEFAULT_PERSONA,
      ...parsed,
      hue: deriveHue(parsed.userRole, parsed.aiRole),
    }
  } catch {
    return DEFAULT_PERSONA
  }
}

export function savePersona(persona) {
  localStorage.setItem(PERSONA_KEY, JSON.stringify(persona))
}

export function personaText(key, persona, t) {
  const base = t ? t(`persona.${key}`) : i18n.t(`persona.${key}`)
  if (!persona || !persona.enabled || !persona.userRole || !persona.aiRole) return base
  if (persona.generatedCopy?.[key]) return persona.generatedCopy[key]
  return base
}

export function deriveHue(userRole = '', aiRole = '') {
  const key = `${userRole.trim().toLowerCase()}|${aiRole.trim().toLowerCase()}`
  if (!key.replace('|', '')) return 230
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % 360
}

function normalize(role = '') {
  return role
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '')
}

// Mood is triggered by user role, except 'casual' which is triggered by AI role.
function detectMood(userRole, aiRole) {
  const u = normalize(userRole)
  const a = normalize(aiRole)

  // servant-to-royal — user is royalty
  if (/(raja|ratu|pangeran|putri|king|queen|prince|princess|majesty|lord|lad)/i.test(u))
    return 'servant-to-royal'
  // student-to-teacher — user is teacher
  if (/(guru|dosen|teacher|professor|lecturer|master|sensei)/i.test(u)) return 'student-to-teacher'
  // medical — user is medical professional
  if (/(dokter|doctor|physician|nurse)/i.test(u)) return 'medical'
  // employee-to-boss — user is boss
  if (/(bos|manajer|manager|boss|ceo|director|supervisor|employer)/i.test(u))
    return 'employee-to-boss'
  // casual — AI is a friend
  if (/(teman|sahabat|bestie|friend|buddy|pal|mate)/i.test(a)) return 'casual'

  return 'generic'
}

export function speak(text, _persona, _t) {
  return text
}

export function buildSystemPrompt(persona, t) {
  const base = t ? t('persona.systemPrompt') : i18n.t('persona.systemPrompt')
  if (!persona || !persona.enabled || !persona.userRole || !persona.aiRole) return base

  const u = persona.userRole
  const a = persona.aiRole
  const mood = detectMood(u, a)

  const roleInstruction = t
    ? t('persona.roleInstructionBase', { user: u, ai: a })
    : i18n.t('persona.roleInstructionBase', { user: u, ai: a })

  const moodInstruction = mood !== 'generic' ? ` ${resolveMoodInstruction(mood, persona, t)}` : ''

  return `${base} ${roleInstruction}${moodInstruction}`
}

function resolveMoodInstruction(mood, persona, t) {
  const instructions = {
    'servant-to-royal':
      'Gunakan bahasa yang sangat hormat, sopan, dan layaknya laporan kepada raja/ratu.',
    'student-to-teacher': 'Gunakan bahasa yang sopan seperti anak didik berbicara kepada gurunya.',
    medical: 'Gunakan bahasa yang tenang, jelas, dan profesional.',
    'employee-to-boss': 'Gunakan bahasa formal dan ringkas seperti laporan kepada atasan.',
    casual: 'Gunakan bahasa santai dan akrab.',
  }
  const enInstructions = {
    'servant-to-royal': 'Use very respectful, polite language befitting a report to royalty.',
    'student-to-teacher': 'Use polite language like a student speaking to a teacher.',
    medical: 'Use calm, clear, and professional language.',
    'employee-to-boss': 'Use formal, concise language like a report to a superior.',
    casual: 'Use casual, friendly language.',
  }
  const lang = (t && t.language) || i18n.language
  const dict = lang === 'id' ? instructions : enInstructions
  return dict[mood] || instructions[mood]
}

export function generatePersonaCopy(persona, aiKey, provider, t, opts = {}) {
  if (!persona.enabled || !persona.userRole || !persona.aiRole || !aiKey) {
    return Promise.resolve(null)
  }

  const translate = t || i18n.t
  const lang = i18n.language

  const copyEntries = [
    'homeLead',
    'inventoryLead',
    'planLeadNoKey',
    'planLead',
    'historyLead',
    'receiptLead',
    'settingsLead',
    'assistantGreeting',
    'assistantQuestion',
  ]

  const copyBlock = copyEntries
    .map((key) => `${key}: """${translate(`persona.${key}`)}"""`)
    .join('\n')

  const isId = lang === 'id'
  const role = persona.aiRole
  const target = persona.userRole

  const intro = isId
    ? `Kamu sedang menyesuaikan bahasa aplikasi RumaQ (asisten inventaris rumah tangga) agar sesuai peran.\n\nPengguna menyatakan: "saya adalah ${target}, kamu adalah ${role}".\nArtinya, seluruh teks aplikasi harus ditulis seolah-olah aplikasi/kamu (${role}) sedang berbicara kepada pengguna (${target}).`
    : `You are adapting the language of RumaQ (a household inventory assistant) to match roles.\n\nThe user declared: "I am ${target}, you are ${role}".\nThis means all app text should be written as if the app/you (${role}) are speaking to the user (${target}).`

  const task = isId
    ? `Tugas:\n1. Tulis ulang setiap teks di atas dengan gaya, pilihan kata, dan tingkat formalitas yang cocok untuk peran "${role}" berbicara kepada "${target}".\n2. Jangan ubah makna atau informasi penting (misalnya tetap sebutkan struk, stok, rencana, dll).\n3. Jangan membuat teks terlalu panjang; tetap singkat dan nyaman dibaca di layar kecil.\n4. Kembalikan hasil dalam format JSON murni, kunci sama persis dengan daftar di atas, tanpa markdown atau penjelasan tambahan.`
    : `Task:\n1. Rewrite each text above with style, word choice, and formality matching the role "${role}" speaking to "${target}".\n2. Do not change the meaning or key information (e.g., still mention receipts, stock, plans, etc.).\n3. Keep text concise and comfortable to read on a small screen.\n4. Return the result in pure JSON format, exact same keys as listed above, no markdown or extra explanation.`

  const example = isId
    ? 'Contoh output:\n{\n  "homeLead": "...",\n  "inventoryLead": "..."\n}'
    : 'Example output:\n{\n  "homeLead": "...",\n  "inventoryLead": "..."\n}'

  const prompt = `${intro}\n\nBerikut teks dasar yang perlu ditulis ulang:\n${copyBlock}\n\n${task}\n\n${example}`

  return callAI(prompt, aiKey, provider, opts).then((raw) => {
    const json = stripJsonMarkdown(raw)
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch {
      return null
    }
    const result = {}
    for (const key of copyEntries) {
      result[key] = typeof parsed[key] === 'string' ? parsed[key] : translate(`persona.${key}`)
    }
    return result
  })
  // No catch: failures (missing custom config, network, non-OK responses)
  // must reach the caller so Settings can show them instead of silently
  // keeping the fallback copy.
}

function stripJsonMarkdown(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

async function callOpenAICompatible(prompt, aiKey, baseUrl, model) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    }),
  })
  if (!res.ok) throw new Error(`AI request failed: ${res.status}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

async function callGemini(prompt, aiKey, model) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${aiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  )
  if (!res.ok) throw new Error(`AI request failed: ${res.status}`)
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

async function callAnthropic(prompt, aiKey, model = 'claude-3-haiku-20240307') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': aiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`AI request failed: ${res.status}`)
  const data = await res.json()
  return data.content?.[0]?.text || ''
}

const OLLAMA_BASE_URL = 'https://ollama.com/v1'
const OLLAMA_DEFAULT_MODEL = 'qwen3-vl:235b-instruct'

async function callAI(prompt, aiKey, provider, opts = {}) {
  const model = (opts.model || '').trim()
  switch (provider) {
    case 'gemini':
      return callGemini(prompt, aiKey, model || 'gemini-1.5-flash')
    case 'anthropic':
      return callAnthropic(prompt, aiKey, model)
    case 'openai':
      return callOpenAICompatible(
        prompt,
        aiKey,
        'https://api.openai.com/v1',
        model || 'gpt-4o-mini'
      )
    case 'ollama':
      return callOpenAICompatible(prompt, aiKey, OLLAMA_BASE_URL, model || OLLAMA_DEFAULT_MODEL)
    case 'custom': {
      const baseUrl = (opts.baseUrl || '').trim()
      if (!baseUrl || !model) {
        throw new Error('Custom provider requires a base URL and model in Settings')
      }
      return callOpenAICompatible(prompt, aiKey, baseUrl, model)
    }
    case 'opencode':
    default:
      return callOpenAICompatible(
        prompt,
        aiKey,
        'https://api.opencode.ai/v1',
        model || 'opencode-mini'
      )
  }
}

export async function testAiKey(provider, aiKey, baseUrl) {
  switch (provider) {
    case 'gemini': {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${aiKey}`)
      if (!res.ok) throw new Error('Invalid API key')
      return true
    }
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': aiKey, 'anthropic-version': '2023-06-01' },
      })
      if (!res.ok) throw new Error('Invalid API key')
      return true
    }
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${aiKey}` },
      })
      if (!res.ok) throw new Error('Invalid API key')
      return true
    }
    case 'ollama': {
      const res = await fetch(`${OLLAMA_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${aiKey}` },
      })
      if (!res.ok) throw new Error('Invalid API key')
      return true
    }
    case 'custom': {
      const base = (baseUrl || '').trim().replace(/\/+$/, '')
      if (!base) throw new Error('Base URL required')
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${aiKey}` },
      })
      if (!res.ok) throw new Error('Invalid API key or base URL')
      return true
    }
    case 'opencode':
    default: {
      const res = await fetch('https://api.opencode.ai/v1/models', {
        headers: { Authorization: `Bearer ${aiKey}` },
      })
      if (!res.ok) throw new Error('Invalid API key')
      return true
    }
  }
}

function oklch(l, c, h) {
  return `oklch(${l} ${c} ${h})`
}

export function applyTheme(persona, element = document.documentElement) {
  if (!persona || !persona.enabled) {
    element.style.removeProperty('--accent')
    element.style.removeProperty('--accent-hover')
    element.style.removeProperty('--accent-pressed')
    element.style.removeProperty('--accent-soft')
    element.style.removeProperty('--accent-soft-border')
    element.style.removeProperty('--surface')
    element.style.removeProperty('--surface-raised')
    element.style.removeProperty('--surface-sunken')
    element.dataset.persona = ''
    return
  }

  const h = persona.hue ?? deriveHue(persona.userRole, persona.aiRole)
  element.style.setProperty('--accent', oklch(0.48, 0.13, h))
  element.style.setProperty('--accent-hover', oklch(0.42, 0.14, h))
  element.style.setProperty('--accent-pressed', oklch(0.37, 0.14, h))
  element.style.setProperty('--accent-soft', oklch(0.93, 0.04, h))
  element.style.setProperty('--accent-soft-border', oklch(0.82, 0.06, h))
  element.dataset.persona = `${persona.userRole}|${persona.aiRole}`
}
