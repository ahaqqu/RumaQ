import { describe, it, expect, vi } from 'vite-plus/test'
import { buildPlanPrompt, generateAiPlan, normalizeItemName } from '../lib/plans.js'
import {
  AI_TEST_HOUSEHOLD,
  AI_TEST_USER,
  fakeAiEnvWith,
  openAiChatAnswer,
  resolveTestAccess,
} from './support/ai-door.js'

describe('normalizeItemName', () => {
  it('trims and lowercases with single spaces', () => {
    expect(normalizeItemName('  Susu Cair  ')).toBe('susu cair')
    expect(normalizeItemName('TELUR   10pcs')).toBe('telur 10pcs')
  })
})

describe('buildPlanPrompt', () => {
  it('includes stores, low stock, expiring and recent purchases', () => {
    const prompt = buildPlanPrompt(
      [{ name: 'Milk', qty: 0.5, unit: 'L', run_out_days: 2, expiry_date: null }],
      [{ name: 'Bread', qty: 1, unit: 'pack', expiry_date: '2026-07-27' }],
      [{ name: 'Eggs', store_label: 'Pasar' }],
      [{ label: 'Indomaret' }, { label: 'Alfamart' }],
      'IDR'
    )
    expect(prompt).toContain('Indomaret')
    expect(prompt).toContain('Milk')
    expect(prompt).toContain('Bread')
    expect(prompt).toContain('Eggs')
    expect(prompt).toContain('IDR')
  })
})

async function reasoningCall() {
  const { env } = await fakeAiEnvWith({ reasoning: { model: 'gpt-4o-mini' } })
  const access = await resolveTestAccess(env, 'reasoning')
  return { env, userId: AI_TEST_USER, householdId: AI_TEST_HOUSEHOLD, access }
}

describe('generateAiPlan', () => {
  it('parses the reasoning answer through the door and limits items (#523 P4)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      openAiChatAnswer(
        JSON.stringify({
          items: Array.from({ length: 60 }, (_, i) => ({
            name: `Item ${i}`,
            qty: 1,
            unit: 'pcs',
            store_id: null,
            price_estimate: 1000,
            why: 'low',
          })),
        })
      )
    )
    const plan = await generateAiPlan(
      await reasoningCall(),
      [],
      [],
      [],
      [{ id: 's1', label: 'X' }],
      'IDR'
    )
    expect(plan.items.length).toBe(50)
    // The call's dimensions are the reasoning assignment's own.
    expect(plan.call).toMatchObject({
      capability: 'reasoning',
      model: 'gpt-4o-mini',
      householdId: AI_TEST_HOUSEHOLD,
    })
    expect(plan.usage.output_tokens).toBe(10)
    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(JSON.parse(opts.body as string).model).toBe('gpt-4o-mini')
  })

  it('rejects an answer with no JSON instead of silently returning an empty plan', async () => {
    // The previous inline `content.match(/\{...\}/)` copy quietly produced []
    // for any unparseable answer; the one extraction policy makes it a typed
    // failure the route can answer 502 for (plan §2.5).
    globalThis.fetch = vi.fn().mockResolvedValue(openAiChatAnswer('not json'))
    await expect(generateAiPlan(await reasoningCall(), [], [], [], [], 'IDR')).rejects.toThrow(
      /did not contain valid JSON/
    )
  })

  it('rejects an off-schema answer through the plan schema', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        openAiChatAnswer(JSON.stringify({ items: [{ name: '', qty: -1, unit: 5, why: '' }] }))
      )
    await expect(generateAiPlan(await reasoningCall(), [], [], [], [], 'IDR')).rejects.toThrow()
  })
})
