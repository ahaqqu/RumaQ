// Post-deploy self-check: proves the shipped tree can actually run the
// nightly job — required env present, state dir writable, and the Tier-2
// browser launches with the installed chromium revision. Runs on the VPS as
// the service user (rumaq-scraper-selfcheck.service) right after a deploy,
// so a broken deploy turns the deploy red instead of surfacing at 06:00 WIB.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Effect } from 'effect'

import { playwrightLauncher } from './fetch/browser.js'
import type { FetchLike } from './fetch/strategy.js'
import { DEFAULT_VISION_MODEL_CHAIN } from './config.js'
import { parseModelChain } from './util/model-chain.js'

export class SelfCheckFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelfCheckFailure'
  }
}

export interface SelfCheckOptions {
  stateDir: string
  /** Publish mode demands the ingest credentials (the nightly job POSTs). */
  publish: boolean
  env?: NodeJS.ProcessEnv
  launcher?: ReturnType<typeof playwrightLauncher>
  /**
   * Injectable ListModels probe (issue #347): returns the model names the
   * key's cohort can see (`models/<id>`); the default fetches the catalog,
   * following its pagination. Tests never touch the network.
   */
  listModels?: (apiKey: string) => Promise<string[]>
  log?: (message: string) => void
}

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

/**
 * The browser check is the deploy's health check — vps-deploy starts
 * rumaq-scraper-selfcheck.service after every swap — so this hint is the
 * operator's only explanation on the rollback path. The deploy never installs a
 * Chromium revision: browsers/ is preserved state. A revision bump installs it
 * from the uploaded artifact as the deploy identity, heals the modes Chromium's
 * installer leaves at 0700 for the service user, and re-runs the deploy.
 */
const BROWSER_REVISION_RECOVERY =
  'the deploy (`sudo -n /usr/local/sbin/vps-deploy rumaq`) does not install Chromium; ' +
  'install the revision the uploaded playwright-core expects as rumaq-deploy ' +
  '(scripts/deploy/browser-revision.sh sets PLAYWRIGHT_BROWSERS_PATH=/srv/rumaq-scraper/browsers), ' +
  'heal the installer modes with `chmod 755 /srv/rumaq-scraper/browsers && chmod -R go+rX /srv/rumaq-scraper/browsers`, ' +
  'then redeploy. Host config and applier: ahaqqu/vps'

function checkEnv(options: SelfCheckOptions): CheckResult {
  const env = options.env ?? process.env
  const missing: string[] = []
  if (!env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY')
  if (options.publish) {
    if (!env.RUMAQ_INGEST_URL) missing.push('RUMAQ_INGEST_URL')
    if (!env.RUMAQ_INGEST_SECRET) missing.push('RUMAQ_INGEST_SECRET')
  }
  return {
    name: 'env',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? options.publish
          ? 'GEMINI_API_KEY + ingest credentials present'
          : 'GEMINI_API_KEY present (dry-run: ingest credentials optional)'
        : `missing: ${missing.join(', ')} (from /etc/rumaq-scraper/env)`,
  }
}

async function checkStateDir(stateDir: string): Promise<CheckResult> {
  try {
    await mkdir(stateDir, { recursive: true })
    const probe = path.join(stateDir, '.selfcheck-probe')
    await writeFile(probe, 'ok', 'utf8')
    await rm(probe, { force: true })
    return { name: 'state-dir', ok: true, detail: `${stateDir} writable` }
  } catch (cause) {
    return { name: 'state-dir', ok: false, detail: `${stateDir} not writable: ${String(cause)}` }
  }
}

async function checkBrowser(options: SelfCheckOptions): Promise<CheckResult> {
  const name = 'browser'
  const detail =
    'chromium launched, tab opened and closed ' +
    `(PLAYWRIGHT_BROWSERS_PATH=${options.env?.PLAYWRIGHT_BROWSERS_PATH ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? 'unset'})`
  try {
    const launcher = options.launcher ?? playwrightLauncher()
    const session = await launcher.launch()
    try {
      const page = await session.newPage()
      await page.goto('about:blank', 5_000)
      await page.close()
    } finally {
      await session.close()
    }
    return { name, ok: true, detail }
  } catch (cause) {
    return {
      name,
      ok: false,
      detail: `${String(cause)} — ${BROWSER_REVISION_RECOVERY}`,
    }
  }
}

/**
 * The default ListModels probe body: GETs the API version the SDK's
 * generateContent actually hits (v1beta) — no generateContent call, selfcheck
 * stays cheap — and follows `nextPageToken` until the catalog is exhausted.
 * The endpoint pages its model list (~50 per page), so a single-page read
 * would hide later chain rungs behind a spurious "not visible" — worst case a
 * false zero-visible deploy FAIL (thermos A1, issue #347). Returns the raw
 * `models/<id>` names.
 */
export async function listAllModelNames(doFetch: FetchLike, apiKey: string): Promise<string[]> {
  const names: string[] = []
  let pageToken: string | undefined
  do {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models' +
      `?key=${encodeURIComponent(apiKey)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
    const response = await doFetch(url)
    if (!response.ok) throw new Error(`ListModels HTTP ${response.status}`)
    const body = (await response.json()) as {
      models?: { name?: string }[]
      nextPageToken?: string
    }
    for (const model of body.models ?? []) {
      if (model.name) names.push(model.name)
    }
    pageToken = body.nextPageToken
  } while (pageToken)
  return names
}

async function defaultListModels(apiKey: string): Promise<string[]> {
  return listAllModelNames(fetch, apiKey)
}

/**
 * The model-chain visibility probe (issue #347): cohort visibility of the
 * configured vision chain varies per key — a missing rung is the DESIGNED
 * case (it skips on 404), so only zero visible rungs or a probe transport
 * failure fail the deploy (cannot-prove-it-runs, browser-check precedent).
 * The effective chain is parsed from the injected env (never loadConfig(),
 * which reads process.env directly and would break env injection).
 */
async function checkGeminiChain(options: SelfCheckOptions): Promise<CheckResult | null> {
  const name = 'gemini-chain'
  const env = options.env ?? process.env
  const apiKey = env.GEMINI_API_KEY
  // The env check already reports a missing key — the probe is skipped
  // entirely (there is nothing to probe without a key).
  if (!apiKey) return null
  const chainEnv = env.GEMINI_MODEL_CHAIN
  const scalar = env.GEMINI_MODEL?.trim() ?? ''
  const chain = parseModelChain(chainEnv, scalar || undefined, DEFAULT_VISION_MODEL_CHAIN)
  // The pin collapsed the chain to one rung (scalar set, CHAIN unset/empty).
  const pinned = scalar.length > 0 && parseModelChain(chainEnv, undefined, []).length === 0

  let visibleNames: string[]
  try {
    visibleNames = await (options.listModels ?? defaultListModels)(apiKey)
  } catch (cause) {
    return { name, ok: false, detail: `ListModels probe failed: ${String(cause)}` }
  }
  const missing = chain.filter((id) => !visibleNames.includes(`models/${id}`))

  if (missing.length === chain.length) {
    return {
      name,
      ok: false,
      detail:
        `none of the ${chain.length} chain ids are visible to this key — ` +
        `the nightly OCR would be dead. Visible models: ` +
        `${visibleNames.slice(0, 8).join(', ') || 'none returned'} — ` +
        'override with GEMINI_MODEL_CHAIN',
    }
  }
  if (pinned) {
    return {
      name,
      ok: true,
      detail: `GEMINI_MODEL pin: chain collapsed to 1 rung — failover disabled`,
    }
  }
  if (missing.length > 0) {
    return {
      name,
      ok: true,
      detail: `key cannot see: ${missing.join(', ')} — these rungs will skip on 404`,
    }
  }
  return { name, ok: true, detail: `all ${chain.length} chain ids visible for this key` }
}

/**
 * Run all checks; resolves with the results. The caller (main.ts) turns any
 * failed check into exit code 1 — a deploy that cannot prove the tree runs
 * has not deployed.
 */
export function runSelfCheck(options: SelfCheckOptions): Effect.Effect<CheckResult[], never> {
  const log = options.log ?? (() => {})
  return Effect.promise(async () => {
    const results: CheckResult[] = []
    const env = checkEnv(options)
    results.push(env)
    log(`selfcheck: ${env.ok ? 'ok' : 'FAIL'} env — ${env.detail}`)
    const state = await checkStateDir(options.stateDir)
    results.push(state)
    log(`selfcheck: ${state.ok ? 'ok' : 'FAIL'} state-dir — ${state.detail}`)
    const browser = await checkBrowser(options)
    results.push(browser)
    log(`selfcheck: ${browser.ok ? 'ok' : 'FAIL'} browser — ${browser.detail}`)
    const chain = await checkGeminiChain(options)
    if (chain) {
      results.push(chain)
      log(`selfcheck: ${chain.ok ? 'ok' : 'FAIL'} gemini-chain — ${chain.detail}`)
    }
    return results
  })
}
