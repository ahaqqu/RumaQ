import { describe, it, expect, vi } from 'vite-plus/test'
import { buildChatSystemPrompt, sendChatMessage } from '../lib/chat.js'

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
  it('calls completeText with conversation history', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Reply' } }] }),
    })
    const reply = await sendChatMessage(
      'openai',
      'sk-test',
      {
        persona: null,
        lowStock: [],
        expiring: [],
        activePlan: [],
        recentPurchases: [],
      },
      'hi',
      [{ role: 'user', content: 'previous' }]
    )
    expect(reply).toBe('Reply')
    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(opts.body as string)
    expect(body.messages[body.messages.length - 1].content).toContain('hi')
  })
})
