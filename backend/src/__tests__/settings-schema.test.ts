import { describe, it, expect } from 'vite-plus/test'
import { safeParse } from 'valibot'
import {
  settingsPatchSchema,
  locationSchema,
  storeSchema,
  aiProviderCreateSchema,
  aiProviderPatchSchema,
  aiCapabilityAssignSchema,
} from '../schemas.js'

// ahaqqu/RumaQ#523 P3: the six legacy `user_settings.ai_*` fields are gone from
// this schema with the columns migration 0042 drops (plan §4.3). A payload that
// still sends `ai_key` is a 400 — the strict object is what makes the dead
// write of P1/P2 impossible rather than merely ignored.
describe('settingsPatchSchema', () => {
  it('accepts a partial update with valid fields', () => {
    const result = safeParse(settingsPatchSchema, {
      language: 'id',
      theme_hue: 210,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.output.language).toBe('id')
      expect(result.output.theme_hue).toBe(210)
    }
  })

  it('accepts all remaining preference fields at once', () => {
    const result = safeParse(settingsPatchSchema, {
      persona_user_role: 'chef',
      persona_ai_role: 'assistant',
      persona_enabled: true,
      motion_preference: 'reduced',
      language: 'id',
      theme_hue: 200,
    })
    expect(result.success).toBe(true)
  })

  it('rejects every legacy AI field (the columns no longer exist)', () => {
    // One per dropped column: PATCH must not accept a write that has nowhere to
    // land. This is the test that would catch a re-introduced compatibility
    // window (the owner decided there is none, D6).
    for (const field of [
      'ai_provider',
      'ai_key',
      'ai_base_url',
      'ai_model',
      'ai_vision_model',
      'ai_thinking_level',
    ]) {
      const result = safeParse(settingsPatchSchema, { [field]: 'whatever' })
      expect(result.success, `${field} must be rejected`).toBe(false)
    }
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

  it('accepts empty object (no fields to update)', () => {
    const result = safeParse(settingsPatchSchema, {})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.keys(result.output).length).toBe(0)
    }
  })
})

describe('aiProviderCreateSchema (#523 P3)', () => {
  it('accepts every wire kind with a key', () => {
    for (const kind of ['openai-compatible', 'anthropic', 'gemini', 'questions']) {
      const result = safeParse(aiProviderCreateSchema, {
        label: 'Work account',
        kind,
        api_key: 'sk-test',
      })
      expect(result.success, kind).toBe(true)
    }
  })

  it('rejects an unknown kind (the CHECK closes the set)', () => {
    const result = safeParse(aiProviderCreateSchema, {
      label: 'Nope',
      kind: 'cohere',
      api_key: 'sk-test',
    })
    expect(result.success).toBe(false)
  })

  it('requires a label and a key', () => {
    expect(safeParse(aiProviderCreateSchema, { kind: 'gemini', api_key: 'sk-test' }).success).toBe(
      false
    )
    expect(safeParse(aiProviderCreateSchema, { label: 'x', kind: 'gemini' }).success).toBe(false)
    // Write-only means a non-empty value on create; '' is a re-key operation.
    expect(
      safeParse(aiProviderCreateSchema, { label: 'x', kind: 'gemini', api_key: '' }).success
    ).toBe(false)
  })

  it('caps the label at 60 characters and the base URL at 500', () => {
    expect(
      safeParse(aiProviderCreateSchema, {
        label: 'l'.repeat(61),
        kind: 'gemini',
        api_key: 'sk',
      }).success
    ).toBe(false)
    expect(
      safeParse(aiProviderCreateSchema, {
        label: 'ok',
        kind: 'openai-compatible',
        base_url: `https://x.test/${'a'.repeat(500)}`,
        api_key: 'sk',
      }).success
    ).toBe(false)
  })

  it('shares the model charset for default_model (ids go into request bodies and URL paths)', () => {
    for (const model of ['gemini-3.6-flash', 'llama3.3:70b', 'qwen2.5@2024', '']) {
      expect(
        safeParse(aiProviderCreateSchema, {
          label: 'x',
          kind: 'gemini',
          api_key: 'sk',
          default_model: model,
        }).success,
        model
      ).toBe(true)
    }
    for (const model of ['gemini?key=exfil', '-leading-dash', 'g'.repeat(201)]) {
      expect(
        safeParse(aiProviderCreateSchema, {
          label: 'x',
          kind: 'gemini',
          api_key: 'sk',
          default_model: model,
        }).success,
        model
      ).toBe(false)
    }
  })

  it('bounds the preset id without enumerating vendors (a new vendor is a data row)', () => {
    expect(
      safeParse(aiProviderCreateSchema, {
        label: 'x',
        kind: 'openai-compatible',
        api_key: 'sk',
        preset: 'brand-new-vendor',
      }).success
    ).toBe(true)
    expect(
      safeParse(aiProviderCreateSchema, {
        label: 'x',
        kind: 'openai-compatible',
        api_key: 'sk',
        preset: 'p'.repeat(41),
      }).success
    ).toBe(false)
  })
})

describe('aiProviderPatchSchema (#523 P3)', () => {
  it('accepts a label-only update and an empty body', () => {
    expect(safeParse(aiProviderPatchSchema, { label: 'New name' }).success).toBe(true)
    expect(safeParse(aiProviderPatchSchema, {}).success).toBe(true)
  })

  it('accepts empty strings, which clear the column / key', () => {
    const result = safeParse(aiProviderPatchSchema, {
      base_url: '',
      default_model: '',
      api_key: '',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown kind and over-long values', () => {
    expect(safeParse(aiProviderPatchSchema, { kind: 'cohere' }).success).toBe(false)
    expect(safeParse(aiProviderPatchSchema, { label: '' }).success).toBe(false)
    expect(safeParse(aiProviderPatchSchema, { default_model: 'bad model' }).success).toBe(false)
  })
})

describe('aiCapabilityAssignSchema (#523 P3)', () => {
  it('accepts a provider id with optional model and thinking level', () => {
    expect(safeParse(aiCapabilityAssignSchema, { provider_id: 'p1' }).success).toBe(true)
    expect(
      safeParse(aiCapabilityAssignSchema, {
        provider_id: 'p1',
        model: 'gemini-3.6-flash',
        thinking_level: 'high',
      }).success
    ).toBe(true)
    // '' = inherit the provider default / no thinking level.
    expect(
      safeParse(aiCapabilityAssignSchema, {
        provider_id: 'p1',
        model: '',
        thinking_level: '',
      }).success
    ).toBe(true)
  })

  it('requires a provider id', () => {
    expect(safeParse(aiCapabilityAssignSchema, {}).success).toBe(false)
    expect(safeParse(aiCapabilityAssignSchema, { provider_id: '' }).success).toBe(false)
  })

  it('rejects an unknown thinking level', () => {
    expect(
      safeParse(aiCapabilityAssignSchema, { provider_id: 'p1', thinking_level: 'max' }).success
    ).toBe(false)
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
