// Self-check tests — the post-deploy gate must fail by name, not vibes.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vite-plus/test'
import { Effect } from 'effect'

import { listAllModelNames, runSelfCheck } from '../src/selfcheck.js'
import { DEFAULT_VISION_MODEL_CHAIN } from '../src/config.js'
import type { BrowserLauncher } from '../src/fetch/browser.js'
import type { FetchLike } from '../src/fetch/strategy.js'

const okLauncher: BrowserLauncher = {
  launch: async () => ({
    newPage: async () => ({
      goto: async () => {},
      waitFor: async () => {},
      content: async () => '',
      close: async () => {},
    }),
    close: async () => {},
  }),
}

const failingLauncher: BrowserLauncher = {
  launch: async () => {
    throw new Error("Executable doesn't exist at /srv/rumaq-scraper/browsers/chromium-1234/...")
  },
}

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { GEMINI_API_KEY: 'k', RUMAQ_INGEST_URL: 'u', RUMAQ_INGEST_SECRET: 's', ...over }
}

// Injectable ListModels probes (issue #347) — tests never touch the network.
const CHAIN_NAMES = DEFAULT_VISION_MODEL_CHAIN.map((id) => `models/${id}`)
const listAll = vi.fn(async () => [...CHAIN_NAMES])
const listPartial = vi.fn(async () => CHAIN_NAMES.slice(0, 2))
const listNone = vi.fn(async () => ['models/gemini-2.0-flash', 'models/gemini-2.5-flash'])
const listBoom = vi.fn(async () => {
  throw new Error('ListModels HTTP 400')
})

function chainResult(results: { name: string; ok: boolean; detail: string }[]) {
  return results.find((result) => result.name === 'gemini-chain')!
}

describe('runSelfCheck', () => {
  it('passes with env, writable state dir, a launching browser, and a visible chain', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: true,
          env: env(),
          launcher: okLauncher,
          listModels: listAll,
        })
      )
      expect(results.every((result) => result.ok)).toBe(true)
      expect(results.map((result) => result.name)).toEqual([
        'env',
        'state-dir',
        'browser',
        'gemini-chain',
      ])
      expect(chainResult(results)!.detail).toContain('all 5 chain ids visible')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('fails by name when the Gemini key is missing', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: false,
          env: env({ GEMINI_API_KEY: '' }),
          launcher: okLauncher,
          listModels: listAll,
        })
      )
      const envCheck = results.find((result) => result.name === 'env')!
      expect(envCheck.ok).toBe(false)
      expect(envCheck.detail).toContain('GEMINI_API_KEY')
      // Without a key there is nothing to probe — the chain check is skipped
      // entirely (the env check already carries the failure).
      expect(results.map((result) => result.name)).toEqual(['env', 'state-dir', 'browser'])
      expect(listAll).not.toHaveBeenCalled()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('dry-run tolerates missing ingest credentials; publish mode does not', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const noIngest = env({ RUMAQ_INGEST_SECRET: '', RUMAQ_INGEST_URL: '' })
      const dry = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: false,
          env: noIngest,
          launcher: okLauncher,
          listModels: listAll,
        })
      )
      expect(dry.find((result) => result.name === 'env')!.ok).toBe(true)

      const live = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: true,
          env: noIngest,
          launcher: okLauncher,
          listModels: listAll,
        })
      )
      const envCheck = live.find((result) => result.name === 'env')!
      expect(envCheck.ok).toBe(false)
      expect(envCheck.detail).toContain('RUMAQ_INGEST_SECRET')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('a missing chromium revision fails the browser check with the current recovery hint', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: false,
          env: env(),
          launcher: failingLauncher,
          listModels: listAll,
        })
      )
      const browser = results.find((result) => result.name === 'browser')!
      expect(browser.ok).toBe(false)
      expect(browser.detail).toContain('vps-deploy rumaq')
      expect(browser.detail).toContain('browser-revision.sh')
      expect(browser.detail).toContain('PLAYWRIGHT_BROWSERS_PATH=/srv/rumaq-scraper/browsers')
      expect(browser.detail).toContain('chmod -R go+rX')
      expect(browser.detail).not.toContain('apply.sh')
      expect(browser.detail).not.toContain('deploy installs')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})

// The gemini-chain probe (issue #347): a missing rung is the DESIGNED case
// (skips on 404), so only zero visible rungs or a probe transport failure
// fail the deploy.

describe('runSelfCheck — gemini-chain probe', () => {
  it('partial visibility stays ok and names the missing rungs', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: false,
          env: env(),
          launcher: okLauncher,
          listModels: listPartial,
        })
      )
      const chain = chainResult(results)!
      expect(chain.ok).toBe(true)
      expect(chain.detail).toContain(
        `key cannot see: ${DEFAULT_VISION_MODEL_CHAIN.slice(2).join(', ')}`
      )
      expect(chain.detail).toContain('skip on 404')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('zero visible rungs fails the deploy and lists what the key CAN see', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: false,
          env: env(),
          launcher: okLauncher,
          listModels: listNone,
        })
      )
      const chain = chainResult(results)!
      expect(chain.ok).toBe(false)
      expect(chain.detail).toContain('none of the 5 chain ids are visible')
      expect(chain.detail).toContain('models/gemini-2.0-flash')
      expect(chain.detail).toContain('GEMINI_MODEL_CHAIN')
      expect(results.some((result) => !result.ok)).toBe(true)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('a probe transport failure fails the deploy with the raw error', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: false,
          env: env(),
          launcher: okLauncher,
          listModels: listBoom,
        })
      )
      const chain = chainResult(results)!
      expect(chain.ok).toBe(false)
      expect(chain.detail).toContain('ListModels HTTP 400')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('a scalar pin collapses the chain and reports failover as disabled', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: false,
          env: env({ GEMINI_MODEL: 'gemini-3.8-flash' }),
          launcher: okLauncher,
          listModels: listAll,
        })
      )
      const chain = chainResult(results)!
      expect(chain.ok).toBe(true)
      expect(chain.detail).toContain('failover disabled')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('parses the effective chain from the injected env, not process.env', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({
          stateDir,
          publish: false,
          env: env({ GEMINI_MODEL_CHAIN: 'gemini-x, gemini-y' }),
          launcher: okLauncher,
          listModels: vi.fn(async () => ['models/gemini-x']),
        })
      )
      const chain = chainResult(results)!
      expect(chain.ok).toBe(true)
      expect(chain.detail).toBe('key cannot see: gemini-y — these rungs will skip on 404')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})

// The default probe's pagination (thermos A1): ListModels pages its catalog
// (~50 per page), so a single-page read could hide chain rungs behind a
// spurious "not visible" — up to a false zero-visible deploy FAIL. The helper
// takes the fetch impl, so these stay offline.
describe('listAllModelNames', () => {
  function pagedFetch(pages: unknown[], urls: string[]): FetchLike {
    return async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(pages.shift() ?? {}), { status: 200 })
    }
  }

  it('follows nextPageToken until the catalog is exhausted and carries the key on every page', async () => {
    const urls: string[] = []
    const doFetch = pagedFetch(
      [
        {
          models: [{ name: 'models/gemini-a' }, { name: 'models/gemini-b' }, { name: '' }],
          nextPageToken: 'page-2',
        },
        { models: [{ name: 'models/gemini-c' }] },
      ],
      urls
    )
    const names = await listAllModelNames(doFetch, 'k-or-ey')
    // Blank names are dropped; both pages collected in order.
    expect(names).toEqual(['models/gemini-a', 'models/gemini-b', 'models/gemini-c'])
    expect(urls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models?key=k-or-ey',
      'https://generativelanguage.googleapis.com/v1beta/models?key=k-or-ey&pageToken=page-2',
    ])
  })

  it('a non-ok page throws the raw ListModels status (the transport-FAIL path)', async () => {
    const doFetch: FetchLike = async () => new Response('{}', { status: 403 })
    await expect(listAllModelNames(doFetch, 'k')).rejects.toThrow('ListModels HTTP 403')
  })
})
