import { describe, it, expect, vi } from 'vite-plus/test'
import { buildPlanPrompt, generateAiPlan, normalizeItemName } from '../lib/plans.js'
import { AiError } from '../lib/ai/index.js'
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
      [
        { id: '11111111-1111-4111-8111-111111111111', label: 'Indomaret' },
        { id: '22222222-2222-4222-8222-222222222222', label: 'Alfamart' },
      ],
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
    // #519: the prompt hands the model the store ids it is asked to answer with.
    const userMessage = (
      JSON.parse(opts.body as string).messages as Array<{ role: string; content: string }>
    )[1]
    expect(userMessage.role).toBe('user')
    expect(userMessage.content).toContain('s1')
    expect(userMessage.content).toContain('X')
  })

  it('rejects an answer with no JSON instead of silently returning an empty plan', async () => {
    // The previous inline `content.match(/\{...\}/)` copy quietly produced []
    // for any unparseable answer; the one extraction policy makes it a typed
    // failure the route can answer 502 for (plan §2.5).
    globalThis.fetch = vi.fn().mockResolvedValue(openAiChatAnswer('not json'))
    // The failure carries the call's bill: the route records the attempt from
    // `AiError.call`/`usage` (plan §2.2), so it must be an AiError, not a plain
    // parse error.
    const failure = await generateAiPlan(await reasoningCall(), [], [], [], [], 'IDR').catch(
      (err: unknown) => err
    )
    expect(failure).toBeInstanceOf(AiError)
    expect(failure).toMatchObject({
      code: 'invalid_response',
      call: { capability: 'reasoning', model: 'gpt-4o-mini' },
      usage: { input_tokens: 100, output_tokens: 10 },
    })
  })

  it('keeps an item without a "why" — the field is optional in the save contract too', async () => {
    // #523 P4 review A2: the answer schema required `why`, so one cosmetic
    // omission sank the whole plan (502) where `planCreateSchema` and the old
    // mapper both accept it.
    globalThis.fetch = vi.fn().mockResolvedValue(
      openAiChatAnswer(
        JSON.stringify({
          items: [
            { name: 'Susu', qty: 1, unit: 'L', store_id: null, price_estimate: 18000 },
            { name: 'Roti', qty: 2, unit: 'pack', store_id: 's1', why: 'Habis' },
          ],
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
    expect(plan.items).toEqual([
      { name: 'Susu', qty: 1, unit: 'L', store_id: null, price_estimate: 18000, why: '' },
      { name: 'Roti', qty: 2, unit: 'pack', store_id: 's1', price_estimate: null, why: 'Habis' },
    ])
  })

  it('remaps an unknown store_id to null instead of passing it to the save route (#519)', async () => {
    // The prompt lists only the household's own store ids; an answer that
    // invents one must not poison the payload POST /api/plans would 400 on.
    // The fallback is null — the same "no store" a nullable column and the
    // UI's "Other stores" group already carry.
    globalThis.fetch = vi.fn().mockResolvedValue(
      openAiChatAnswer(
        JSON.stringify({
          items: [
            { name: 'Susu', qty: 1, unit: 'L', store_id: '99999999-9999-4999-8999-999999999999' },
            { name: 'Roti', qty: 2, unit: 'pack', store_id: 's1' },
          ],
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
    expect(plan.items.map((it) => it.store_id)).toEqual([null, 's1'])
  })

  it("treats another household's store id as unknown — same null as a random one (#519)", async () => {
    // The valid set is the caller's household-scoped stores query; a foreign
    // household's id misses it exactly like a hallucinated one. No existence
    // oracle: both fall back to null with the same response shape.
    globalThis.fetch = vi.fn().mockResolvedValue(
      openAiChatAnswer(
        JSON.stringify({
          items: [
            { name: 'Susu', qty: 1, unit: 'L', store_id: 'foreign-store-id' },
            {
              name: 'Roti',
              qty: 2,
              unit: 'pack',
              store_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
          ],
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
    expect(plan.items.map((it) => it.store_id)).toEqual([null, null])
  })

  it('falls back to null for every store_id when the household has no stores (#519)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      openAiChatAnswer(
        JSON.stringify({
          items: [{ name: 'Susu', qty: 1, unit: 'L', store_id: 's1' }],
        })
      )
    )
    const plan = await generateAiPlan(await reasoningCall(), [], [], [], [], 'IDR')
    expect(plan.items[0].store_id).toBeNull()
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
