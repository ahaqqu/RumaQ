// Post-deploy self-check: proves the shipped tree can actually run the
// nightly job — required env present, state dir writable, and the Tier-2
// browser launches with the installed chromium revision. Runs on the VPS as
// the service user (rumaq-scraper-selfcheck.service) right after a deploy,
// so a broken deploy turns the deploy red instead of surfacing at 06:00 WIB.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Effect } from 'effect'

import { playwrightLauncher } from './fetch/browser.js'

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
    return results
  })
}
