import { describe, expect, it } from 'vite-plus/test'

import { AI_PROVIDER_DEFAULTS } from './aiProviders.js'

// The "keep in sync" comment on AI_PROVIDER_DEFAULTS is load-bearing: these
// pins are the drift guard (the ollama default once handed persona
// generation a retired model that 410'd — backend/src/lib/ai.ts fixed its
// own default, the mirror here lagged).
describe('AI_PROVIDER_DEFAULTS', () => {
  it('keeps the ollama default in sync with the backend (glm-5.3-flash)', () => {
    expect(AI_PROVIDER_DEFAULTS.ollama).toBe('glm-5.3-flash')
  })

  it('keeps the gemini default in sync with the backend (gemini-3.6-flash)', () => {
    expect(AI_PROVIDER_DEFAULTS.gemini).toBe('gemini-3.6-flash')
  })
})
