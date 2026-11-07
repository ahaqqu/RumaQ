import { i18n } from '../i18n/index.js'
import { generateAiPersonaCopy } from './api'

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

// The interface slots the persona rewrite may replace: the `persona.*` strings
// the UI renders through personaText(). The backend owns the prompt and rejects
// any other key (backend/src/schemas.ts); persona.test.js pins this list against
// the route's generated request contract, so the two cannot drift.
export const PERSONA_COPY_KEYS = [
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

/**
 * The request the browser sends (#523 P5, plan §6 P5): the two role names, the
 * language the copy is written in, and the built-in strings it wants rewritten.
 * There is no prompt, provider, endpoint or key in this object any more — the
 * prompt is server policy (backend/src/lib/persona.ts) and the provider call
 * happens behind the door, so nothing provider-shaped reaches page memory.
 */
export function buildPersonaCopyRequest(persona, t) {
  const translate = t || i18n.t
  const copy = {}
  for (const key of PERSONA_COPY_KEYS) copy[key] = translate(`persona.${key}`)
  return {
    user_role: (persona.userRole || '').trim(),
    ai_role: (persona.aiRole || '').trim(),
    language: i18n.language === 'id' ? 'id' : 'en',
    copy,
  }
}

/**
 * Ask the household's own provider — through the server, never from here — to
 * rewrite the app copy in the persona roles. Resolves to the rewritten slots,
 * or null when the persona is off or incomplete (there is nothing to rewrite).
 *
 * Failures reach the caller so Settings can show them; a 402 means the
 * household has no usable reasoning assignment, which is the normal
 * "keep the built-in copy" state rather than an error (the caller decides).
 */
export async function generatePersonaCopy(persona, t) {
  if (!persona?.enabled || !persona.userRole || !persona.aiRole) return null
  const { copy } = await generateAiPersonaCopy(buildPersonaCopyRequest(persona, t))
  return copy ?? null
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
