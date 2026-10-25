import { describe, it, expect } from 'vite-plus/test'
import { safeParse } from 'valibot'
import { settingsPatchSchema, locationSchema, storeSchema } from '../schemas.js'

describe('settingsPatchSchema', () => {
  it('accepts a partial update with valid fields', () => {
    const result = safeParse(settingsPatchSchema, {
      ai_provider: 'gemini',
      language: 'id',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.output.ai_provider).toBe('gemini')
      expect(result.output.language).toBe('id')
    }
  })

  it('accepts ai_key as plain text', () => {
    const result = safeParse(settingsPatchSchema, {
      ai_key: 'sk-xxxxxxxxxxxx',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.output.ai_key).toBe('sk-xxxxxxxxxxxx')
    }
  })

  it('accepts all optional fields at once', () => {
    const result = safeParse(settingsPatchSchema, {
      ai_provider: 'openai',
      ai_key: 'sk-test',
      persona_user_role: 'chef',
      persona_ai_role: 'assistant',
      persona_enabled: true,
      motion_preference: 'reduced',
      language: 'id',
      theme_hue: 200,
    })
    expect(result.success).toBe(true)
  })

  it('accepts ollama and custom providers with base URL and model', () => {
    const result = safeParse(settingsPatchSchema, {
      ai_provider: 'ollama',
      ai_key: 'sk-ollama',
    })
    expect(result.success).toBe(true)

    const custom = safeParse(settingsPatchSchema, {
      ai_provider: 'custom',
      ai_key: 'sk-custom',
      ai_base_url: 'https://api.example.com/v1',
      ai_model: 'llama3.3:70b',
    })
    expect(custom.success).toBe(true)
    if (custom.success) {
      expect(custom.output.ai_base_url).toBe('https://api.example.com/v1')
      expect(custom.output.ai_model).toBe('llama3.3:70b')
    }
  })

  it('rejects invalid ai_provider', () => {
    const result = safeParse(settingsPatchSchema, {
      ai_provider: 'invalid-ai',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid motion_preference', () => {
    const result = safeParse(settingsPatchSchema, {
      motion_preference: 'extreme',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid language', () => {
    const result = safeParse(settingsPatchSchema, {
      language: 'fr',
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown fields', () => {
    const result = safeParse(settingsPatchSchema, {
      unknown_field: 'value',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty ai_key', () => {
    const result = safeParse(settingsPatchSchema, {
      ai_key: '',
    })
    expect(result.success).toBe(false)
  })

  it('accepts empty object (no fields to update)', () => {
    const result = safeParse(settingsPatchSchema, {})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.keys(result.output).length).toBe(0)
    }
  })
})

describe('locationSchema', () => {
  it('accepts a valid label', () => {
    const result = safeParse(locationSchema, { label: 'Kitchen' })
    expect(result.success).toBe(true)
  })

  it('rejects empty label', () => {
    const result = safeParse(locationSchema, { label: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing label', () => {
    const result = safeParse(locationSchema, {})
    expect(result.success).toBe(false)
  })
})

describe('storeSchema', () => {
  it('accepts a valid label', () => {
    const result = safeParse(storeSchema, { label: 'Indomaret' })
    expect(result.success).toBe(true)
  })

  it('rejects empty label', () => {
    const result = safeParse(storeSchema, { label: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing label', () => {
    const result = safeParse(storeSchema, {})
    expect(result.success).toBe(false)
  })
})
