// kind → adapter. The ONLY place a `ProviderKind` becomes an implementation
// (plan §2.1). A data map rather than a switch, so adding a wire is one row and
// no branch can silently fall through to a default.

import { anthropicAdapter } from './anthropic.js'
import { geminiAdapter } from './gemini.js'
import { openaiAdapter } from './openai.js'
import { questionsAdapter } from './questions.js'
import { AdapterError, type AiAdapter } from './types.js'
import type { ProviderKind } from '../types.js'

const ADAPTERS: Readonly<Record<ProviderKind, AiAdapter>> = {
  'openai-compatible': openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  questions: questionsAdapter,
}

export function adapterFor(kind: ProviderKind): AiAdapter {
  const adapter = ADAPTERS[kind]
  if (!adapter) {
    // The ai_providers CHECK closes the set; a row that is not one of the four
    // is corrupt, and failing closed beats guessing a wire.
    throw new AdapterError('unsupported', `Unsupported AI provider kind: ${String(kind)}`)
  }
  return adapter
}

export const ADAPTER_KINDS: readonly ProviderKind[] = [
  'openai-compatible',
  'anthropic',
  'gemini',
  'questions',
]
