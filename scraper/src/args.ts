// CLI argument parsing — extracted from main.ts so the rules are unit-testable
// (main.ts is a side-effectful entry: importing it runs the pipeline).

import { SCRAPE_STORE_SLUGS } from '@rumaq/contract'

export type CliArgs = {
  publish: boolean
  selfCheck: boolean
  stateDir: string
  /** Store slugs to scrape; unset = every configured store (the nightly). */
  stores?: string[]
  /** Set when --stores carried an empty or unknown slug list. */
  storesError?: string
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const selfCheck = argv.includes('--self-check')
  const publish =
    argv.includes('--publish') || ['1', 'true', 'yes'].includes(env.RUMAQ_PUBLISH ?? '')
  const stateDirArg = argv.find((arg) => arg.startsWith('--state-dir='))
  const stateDir = stateDirArg
    ? stateDirArg.slice('--state-dir='.length)
    : (env.RUMAQ_SCRAPER_STATE_DIR ?? 'state')

  // --stores=slug1,slug2 scopes a run to the given stores (docs/plan/
  // scrape-now.md §2). Validated here so an unknown slug is a loud usage
  // error, never a silently empty run.
  const storesArg = argv.find((arg) => arg.startsWith('--stores='))
  let stores: string[] | undefined
  let storesError: string | undefined
  if (storesArg !== undefined) {
    const slugs = storesArg
      .slice('--stores='.length)
      .split(',')
      .map((slug) => slug.trim())
      .filter(Boolean)
    const unknown = slugs.filter(
      (slug) => !(SCRAPE_STORE_SLUGS as readonly string[]).includes(slug)
    )
    if (slugs.length === 0) {
      storesError = '--stores= needs at least one store slug'
    } else if (unknown.length > 0) {
      storesError =
        `unknown store slug(s): ${unknown.join(', ')} — ` +
        `known stores: ${SCRAPE_STORE_SLUGS.join(', ')}`
    } else {
      stores = [...new Set(slugs)]
    }
  }

  return { publish, selfCheck, stateDir, stores, storesError }
}
