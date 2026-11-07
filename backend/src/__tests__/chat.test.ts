import { describe, it, expect, vi } from 'vite-plus/test'
import { buildChatSystemPrompt, sendChatMessage } from '../lib/chat.js'
import {
  AI_TEST_HOUSEHOLD,
  AI_TEST_USER,
  fakeAiEnvWith,
  openAiChatAnswer,
  resolveTestAccess,
} from './support/ai-door.js'

describe('buildChatSystemPrompt', () => {
  it('includes household context and base prompt', () => {
    const prompt = buildChatSystemPrompt({
      persona: null,
      lowStock: [{ name: 'Milk', qty: 1, unit: 'L', run_out_days: 2 }],
      expiring: [{ name: 'Bread', qty: 1, unit: 'pack', expiry_date: '2026-07-27' }],
      activePlan: [{ name: 'Eggs', qty: 10, unit: 'pcs', store_label: 'Pasar' }],
      recentPurchases: [{ name: 'Rice', store_label: 'Indomaret' }],
    })
    expect(prompt).toContain('Milk')
    expect(prompt).toContain('Bread')
    expect(prompt).toContain('Eggs')
    expect(prompt).toContain('Rice')
    expect(prompt).toContain('Never reveal')
  })

  it('handles empty context gracefully', () => {
    const prompt = buildChatSystemPrompt({
      persona: null,
      lowStock: [],
      expiring: [],
      activePlan: [],
      recentPurchases: [],
    })
    expect(prompt).toContain('None')
    expect(prompt).toContain('No active plan')
  })
})

describe('sendChatMessage', () => {
  it('sends the conversation history through the resolved reasoning handle (#523 P4)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(openAiChatAnswer('Reply'))
    const { env } = await fakeAiEnvWith({ reasoning: { model: 'gpt-4o-mini' } })
    const access = await resolveTestAccess(env, 'reasoning')

    const result = await sendChatMessage(
      { env, userId: AI_TEST_USER, householdId: AI_TEST_HOUSEHOLD, access },
      { persona: null, lowStock: [], expiring: [], activePlan: [], recentPurchases: [] },
      'hi',
      [{ role: 'user', content: 'previous' }]
    )

    expect(result.text).toBe('Reply')
    // The call dimensions name the capability the door dispatched for.
    expect(result.call).toMatchObject({
      capability: 'reasoning',
      householdId: AI_TEST_HOUSEHOLD,
      model: 'gpt-4o-mini',
      funding: 'household',
    })
    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(opts.body as string)
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages[body.messages.length - 1].content).toContain('hi')
  })

  it('refuses a handle resolved for another capability (fail closed, no provider call)', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const { env } = await fakeAiEnvWith({ reasoning: {}, vision: {} })
    const visionAccess = await resolveTestAccess(env, 'vision')
    await expect(
      sendChatMessage(
        { env, userId: AI_TEST_USER, householdId: AI_TEST_HOUSEHOLD, access: visionAccess },
        { persona: null, lowStock: [], expiring: [], activePlan: [], recentPurchases: [] },
        'hi'
      )
    ).rejects.toThrow(/cannot serve|not 'reasoning'|not usable/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
