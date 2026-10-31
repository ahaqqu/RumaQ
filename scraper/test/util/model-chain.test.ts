// Model-chain unit tests (issue #347) — parse precedence, rung state, and
// the withModelFallback decision table. Error fixtures are verbatim from
// retry.test.ts (haqita port): the daily/per-minute 429 bodies and the
// issue #306 live 404 body. No network, no sleeps — the rung is a plain
// effect the test controls.

import { describe, expect, it, vi } from 'vite-plus/test'
import { Effect } from 'effect'

import {
  createModelChain,
  parseModelChain,
  withModelFallback,
  type ModelChainState,
} from '../../src/util/model-chain.js'
import { classifyQuotaError } from '../../src/util/retry.js'

// Verbatim from retry.test.ts — the haqita-ported quota fixtures.
const DAILY_QUOTA_429 =
  '429 You have exhausted your daily quota. QuotaID: GenerateRequestsPerDayPerProjectPerModel-FreeTier'
const PER_MINUTE_429 = '429 RESOURCE_EXHAUSTED: retry in 30s'
const MODEL_GONE_404 =
  '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash …","status":"NOT_FOUND"}}'
const SATURATION_503 =
  '{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}'
const TRANSIENT_500 = '500 INTERNAL'

const dailyQuota = () =>
  classifyQuotaError(new Error(DAILY_QUOTA_429)) ?? new Error('fixture broken')

describe('parseModelChain', () => {
  const FALLBACK = ['a', 'b', 'c'] as const

  it('chain env wins over the scalar env (wholesale override)', () => {
    expect(parseModelChain('x, y', 'z', FALLBACK)).toEqual(['x', 'y'])
  })

  it('scalar env alone collapses the chain to one rung (pin means pin)', () => {
    expect(parseModelChain(undefined, 'z', FALLBACK)).toEqual(['z'])
  })

  it.each([
    [undefined, undefined],
    ['', ''],
    ['   ', undefined],
    [',', undefined],
    [' , , ', undefined],
  ])('blank/whitespace/comma-only values count as unset: %j', (chain, scalar) => {
    expect(parseModelChain(chain, scalar, FALLBACK)).toEqual(['a', 'b', 'c'])
  })

  it('trims ids and drops empty segments', () => {
    expect(parseModelChain(' a , , b ,', undefined, FALLBACK)).toEqual(['a', 'b'])
  })

  it('keeps the verbatim order — order is load-bearing', () => {
    expect(parseModelChain('z, y, x', undefined, FALLBACK)).toEqual(['z', 'y', 'x'])
  })
})

describe('createModelChain', () => {
  it('refuses a zero-rung chain (unrepresentable state)', () => {
    expect(() => createModelChain([])).toThrow('at least one rung')
  })

  it('current() reads the head, then each advanced rung', () => {
    const chain = createModelChain(['a', 'b'])
    expect(chain.current()).toBe('a')
    expect(chain.exhausted).toBe(false)
    expect(chain.advance('daily-quota 429')).toBe(true)
    expect(chain.current()).toBe('b')
    expect(chain.exhausted).toBe(false)
  })

  it('advance on the last rung returns false, marks exhausted, and records the death', () => {
    const log = vi.fn()
    const chain = createModelChain(['a', 'b'], 'ocr')
    expect(chain.advance('daily-quota 429', log)).toBe(true)
    expect(log).toHaveBeenCalledWith('[chain] ocr rung advanced: a → b (daily-quota 429)')
    expect(chain.advance('daily-quota 429', log)).toBe(false)
    expect(log).toHaveBeenCalledWith('[chain] ocr all 2 rungs exhausted (daily-quota 429)')
    expect(chain.exhausted).toBe(true)
    expect(chain.deaths).toEqual([
      { model: 'a', reason: 'daily-quota 429' },
      { model: 'b', reason: 'daily-quota 429' },
    ])
    // advance is a no-op once exhausted.
    expect(chain.advance('daily-quota 429')).toBe(false)
    expect(chain.deaths).toHaveLength(2)
  })

  it('omits the surface label from the log line when none was given', () => {
    const log = vi.fn()
    const chain = createModelChain(['a', 'b'])
    chain.advance('model-fatal 404', log)
    expect(log).toHaveBeenCalledWith('[chain] rung advanced: a → b (model-fatal 404)')
  })
})

describe('withModelFallback', () => {
  function failingRung(
    errors: unknown[],
    success: string,
    calls: { model: string }[]
  ): (model: string) => Effect.Effect<string, unknown> {
    let attempt = 0
    return (model: string) =>
      Effect.suspend(() => {
        calls.push({ model })
        attempt++
        const error = errors[attempt - 1]
        if (error) return Effect.fail(error)
        return Effect.succeed(success)
      })
  }

  const run = (effect: Effect.Effect<string, unknown>) => Effect.runPromise(effect)

  it('passes a plain string model straight through — even on a chain-trigger error', async () => {
    const calls: { model: string }[] = []
    const chain: string | ModelChainState = 'pinned'
    const result = await run(
      withModelFallback(chain, failingRung([dailyQuota()], 'ok', calls))
    ).catch(() => 'failed')
    // Chain-of-one: the error propagates, no advance attempted.
    expect(result).toBe('failed')
    expect(calls).toEqual([{ model: 'pinned' }])
  })

  it('advances on a daily-quota 429 and retries on the next rung', async () => {
    const calls: { model: string }[] = []
    const chain = createModelChain(['r0', 'r1', 'r2'])
    const log = vi.fn()
    const result = await run(
      withModelFallback(chain, failingRung([dailyQuota()], 'ok', calls), log)
    )
    expect(result).toBe('ok')
    expect(calls.map((call) => call.model)).toEqual(['r0', 'r1'])
    expect(log).toHaveBeenCalledWith('[chain] rung advanced: r0 → r1 (daily-quota 429)')
  })

  it('advances on a model-fatal 404 (skip) and on ladder-escaped 503 saturation', async () => {
    for (const error of [new Error(MODEL_GONE_404), new Error(SATURATION_503)]) {
      const calls: { model: string }[] = []
      const chain = createModelChain(['r0', 'r1'])
      const result = await run(withModelFallback(chain, failingRung([error], 'ok', calls)))
      expect(result).toBe('ok')
      expect(calls.map((call) => call.model)).toEqual(['r0', 'r1'])
    }
  })

  it.each([new Error(PER_MINUTE_429), new Error(TRANSIENT_500)])(
    'never advances on a non-trigger error (%s) — rethrown unchanged',
    async (error) => {
      const calls: { model: string }[] = []
      const chain = createModelChain(['r0', 'r1'])
      await expect(
        run(withModelFallback(chain, failingRung([error], 'ok', calls)))
      ).rejects.toThrow(error.message)
      expect(calls).toEqual([{ model: 'r0' }])
      expect(chain.exhausted).toBe(false)
    }
  )

  it('rethrows the last error unchanged when the final rung dies', async () => {
    const log = vi.fn()
    const chain = createModelChain(['r0', 'r1'])
    const last = dailyQuota()
    let caught: unknown
    await run(withModelFallback(chain, () => Effect.fail(last), log)).catch((error) => {
      caught = error
    })
    expect(caught).toBe(last)
    // Both rungs were attempted (recorded as deaths) before giving up.
    expect(chain.deaths.map((death) => death.model)).toEqual(['r0', 'r1'])
    expect(log).toHaveBeenCalledWith('[chain] all 2 rungs exhausted (daily-quota 429)')
    expect(chain.exhausted).toBe(true)
  })

  it('rethrows a last-rung model-fatal 404 unchanged', async () => {
    const calls: { model: string }[] = []
    const chain = createModelChain(['r0'])
    const last = new Error(MODEL_GONE_404)
    await expect(run(withModelFallback(chain, failingRung([last], 'ok', calls)))).rejects.toThrow(
      /no longer available/
    )
    expect(calls).toEqual([{ model: 'r0' }])
  })

  it('reads the current rung fresh per attempt (state mutated between calls)', async () => {
    const calls: { model: string }[] = []
    const chain = createModelChain(['r0', 'r1'])
    // The first call happens outside; the chain advances; the next
    // withModelFallback picks up the new rung with no re-detection error.
    chain.advance('daily-quota 429')
    const result = await run(withModelFallback(chain, failingRung([], 'ok', calls)))
    expect(result).toBe('ok')
    expect(calls).toEqual([{ model: 'r1' }])
  })
})
