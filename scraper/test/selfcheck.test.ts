// Self-check tests — the post-deploy gate must fail by name, not vibes.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import { runSelfCheck } from '../src/selfcheck.js'
import type { BrowserLauncher } from '../src/fetch/browser.js'

const okLauncher: BrowserLauncher = {
  launch: async () => ({
    newPage: async () => ({ goto: async () => {}, content: async () => '', close: async () => {} }),
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

describe('runSelfCheck', () => {
  it('passes with env, writable state dir, and a launching browser', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({ stateDir, publish: true, env: env(), launcher: okLauncher })
      )
      expect(results.every((result) => result.ok)).toBe(true)
      expect(results.map((result) => result.name)).toEqual(['env', 'state-dir', 'browser'])
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
        })
      )
      const envCheck = results.find((result) => result.name === 'env')!
      expect(envCheck.ok).toBe(false)
      expect(envCheck.detail).toContain('GEMINI_API_KEY')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('dry-run tolerates missing ingest credentials; publish mode does not', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const noIngest = env({ RUMAQ_INGEST_SECRET: '', RUMAQ_INGEST_URL: '' })
      const dry = await Effect.runPromise(
        runSelfCheck({ stateDir, publish: false, env: noIngest, launcher: okLauncher })
      )
      expect(dry.find((result) => result.name === 'env')!.ok).toBe(true)

      const live = await Effect.runPromise(
        runSelfCheck({ stateDir, publish: true, env: noIngest, launcher: okLauncher })
      )
      const envCheck = live.find((result) => result.name === 'env')!
      expect(envCheck.ok).toBe(false)
      expect(envCheck.detail).toContain('RUMAQ_INGEST_SECRET')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('a missing chromium revision fails the browser check with the fix hint', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'rumaq-selfcheck-'))
    try {
      const results = await Effect.runPromise(
        runSelfCheck({ stateDir, publish: false, env: env(), launcher: failingLauncher })
      )
      const browser = results.find((result) => result.name === 'browser')!
      expect(browser.ok).toBe(false)
      expect(browser.detail).toContain('apply.sh --install-deps')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
