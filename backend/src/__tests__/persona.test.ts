import { describe, it, expect } from 'vite-plus/test'
import { buildSystemPrompt } from '../lib/persona.js'

describe('buildSystemPrompt', () => {
  it('returns base prompt when persona is disabled', () => {
    const prompt = buildSystemPrompt({
      persona_enabled: 0,
      persona_user_role: 'raja',
      persona_ai_role: 'prajurit',
    })
    expect(prompt).toContain('RumaQ')
    expect(prompt).not.toContain('{{user}}')
  })

  it('returns base prompt when persona fields are missing', () => {
    expect(buildSystemPrompt(null)).toContain('RumaQ')
    expect(
      buildSystemPrompt({ persona_enabled: 1, persona_user_role: null, persona_ai_role: 'ai' })
    ).toContain('RumaQ')
    expect(
      buildSystemPrompt({ persona_enabled: 1, persona_user_role: 'user', persona_ai_role: null })
    ).toContain('RumaQ')
  })

  it('includes role instruction when enabled', () => {
    const prompt = buildSystemPrompt({
      persona_enabled: 1,
      persona_user_role: 'raja',
      persona_ai_role: 'prajurit',
    })
    expect(prompt).toContain('raja')
    expect(prompt).toContain('prajurit')
    expect(prompt).toContain('Imagine')
  })

  it('detects servant-to-royal mood', () => {
    const prompt = buildSystemPrompt({
      persona_enabled: 1,
      persona_user_role: 'queen',
      persona_ai_role: 'servant',
    })
    expect(prompt).toContain('respectful')
  })

  it('detects student-to-teacher mood', () => {
    const prompt = buildSystemPrompt({
      persona_enabled: 1,
      persona_user_role: 'teacher',
      persona_ai_role: 'student',
    })
    expect(prompt).toContain('polite')
  })

  it('detects medical mood', () => {
    const prompt = buildSystemPrompt({
      persona_enabled: 1,
      persona_user_role: 'doctor',
      persona_ai_role: 'patient',
    })
    expect(prompt).toContain('professional')
  })

  it('detects employee-to-boss mood', () => {
    const prompt = buildSystemPrompt({
      persona_enabled: 1,
      persona_user_role: 'boss',
      persona_ai_role: 'employee',
    })
    expect(prompt).toContain('formal')
  })

  it('detects casual mood from AI role', () => {
    const prompt = buildSystemPrompt({
      persona_enabled: 1,
      persona_user_role: 'user',
      persona_ai_role: 'friend',
    })
    expect(prompt).toContain('casual')
  })

  it('returns generic mood without extra instruction', () => {
    const prompt = buildSystemPrompt({
      persona_enabled: 1,
      persona_user_role: 'user',
      persona_ai_role: 'ai',
    })
    expect(prompt).toContain('RumaQ')
    expect(prompt).not.toContain('respectful')
    expect(prompt).not.toContain('polite')
    expect(prompt).not.toContain('professional')
    expect(prompt).not.toContain('formal')
    expect(prompt).not.toContain('casual')
  })
})
