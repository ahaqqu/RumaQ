// The vendor catalog as DATA (ahaqqu/RumaQ#523, plan §2.1, §4.5). A new vendor
// is a row here — never a migration, never a new `kind`, never a new switch.
//
// Nothing in this list is a default provider: there is no seeded row, no
// preselection, and `GET /api/ai/presets` (P3) merely publishes this catalog.
// No MODEL ids live here either (#523 owner decision): a model is either the
// capability's own or the household's `ai_providers.default_model`, both
// owner-typed data on a row the household chose, so no vendor alias ages in
// code (plan §4.5). A preset is wire + label + canonical endpoint only.

import type { ProviderKind } from './types.js'

export type Preset = {
  id: string
  label: string
  /** The wire this preset speaks. */
  kind: ProviderKind
  /** Canonical base URL; null = the household must supply one ('custom'). */
  endpoint: string | null
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'openai-compatible',
    endpoint: 'https://api.opencode.ai/v1',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    kind: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'ollama',
    label: 'Ollama Cloud',
    kind: 'openai-compatible',
    endpoint: 'https://ollama.com/v1',
  },
  {
    id: 'custom',
    label: 'Custom provider',
    kind: 'openai-compatible',
    endpoint: null,
  },
]

const PRESETS_BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]))

export function presetById(id: string | null): Preset | null {
  return id ? (PRESETS_BY_ID.get(id) ?? null) : null
}

/**
 * The canonical endpoint for a preset row. A preset whose wire disagrees with
 * the row's kind is NOT a usable endpoint: that combination is a hand-edited
 * row (the API validates it in P3), and guessing an OpenAI chat path from an
 * Anthropic base URL is worse than treating the row as needing setup.
 */
export function presetEndpoint(preset: string | null, kind?: ProviderKind): string | null {
  const row = presetById(preset)
  if (!row || row.endpoint === null) return null
  if (kind !== undefined && row.kind !== kind) return null
  return row.endpoint
}

/**
 * The preset ids the legacy dispatcher (lib/ai.ts `callProvider`) understands
 * as a chat wire. Used only by the P1 bridge in ai-access.ts; deleted with it.
 */
export const LEGACY_CHAT_PRESETS: ReadonlySet<string> = new Set(['openai', 'opencode', 'ollama'])
