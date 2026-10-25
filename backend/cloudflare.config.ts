import { bindings, defineConfig } from 'cf/config'

/**
 * Single source of truth for the Worker configuration (replaces the four
 * wrangler.*.toml files). Values that were previously sed-resolved at deploy
 * time are read from the environment directly:
 *
 * - CLOUDFLARE_ACCOUNT_ID   — real account for deploys; falls back to "LOCAL"
 *                             for local dev / test builds (never contacts the API).
 * - CLOUDFLARE_DATABASE_ID  — production D1 database UUID; local/dev/test use
 *                             the all-zero placeholder that keys the local state.
 * - BRANCH_NAME             — branch deploys compute a per-branch worker name
 *                             and preview origin, matching the old deploy.sh logic.
 * - D1_DATABASE_NAME / R2_BUCKET_NAME — resource names (deploy.sh defaults).
 *
 * Secrets are not declared here; they are set per-environment via
 * `cf workers secrets update` (see scripts/deploy.sh).
 */

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'LOCAL'
// Local/dev/test placeholder. Must be a v4-shaped UUID: cf CLI rejects the nil
// UUID, and this same value keys the local D1 state for both the Vite plugin
// and `cf d1 migrations apply --local`.
const LOCAL_DATABASE_ID = '00000000-0000-4000-8000-000000000000'
const databaseId = process.env.CLOUDFLARE_DATABASE_ID ?? LOCAL_DATABASE_ID
const databaseName = process.env.D1_DATABASE_NAME ?? 'rumaq'
const bucketName = process.env.R2_BUCKET_NAME ?? 'rumaq-receipts'

const branch = process.env.BRANCH_NAME ?? 'main'
const isProduction = branch === 'main' || branch === 'master' || branch === 'HEAD'
const sanitizedBranch = branch.replace(/[^a-zA-Z0-9-]/g, '-')

export default defineConfig({
  accountId,
  worker: {
    name: isProduction ? 'api' : `rumaq-api-${sanitizedBranch}`,
    compatibilityDate: '2026-07-10',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: 'src/index.ts',
    // Canonical production hostname, attached as a Worker Custom Domain at
    // deploy time (branch deploys keep their *.workers.dev URL only). The
    // attach REQUIRES the ahaqqu.com zone in the deploying Cloudflare
    // account — without it wrangler fails "Can't infer zone" (code 10082)
    // and, because domains are configured, the *.workers.dev route is not
    // enabled either: production ends up with no reachable URL (outage,
    // 2026-10-26). Opt-in until the zone is in the account: deploy with
    // ATTACH_CUSTOM_DOMAIN=1 to attach it, then flip the URL defaults
    // (pages-redirect, live tests, docs) back to the canonical domain.
    domains:
      isProduction && process.env.ATTACH_CUSTOM_DOMAIN === '1' ? ['rumaq.ahaqqu.com'] : undefined,
    // Single-deploy topology: the Worker serves both the SPA (frontend build,
    // wired in via publicDir in vite.config.ts) and the API. API requests must
    // always reach the user worker; unknown paths fall back to index.html.
    assets: {
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*'],
    },
    env: {
      DB: bindings.d1({ name: databaseName, id: databaseId }),
      RECEIPTS: bindings.r2({ name: bucketName }),
      ASSETS: bindings.assets(),
      EMAIL_AUTH_ENABLED: bindings.text('true'),
      // Startup secrets check only makes sense against a real account; local
      // dev runs on placeholder secrets from .dev.vars.
      RUN_SECRETS_CHECK: bindings.text(accountId === 'LOCAL' ? 'false' : 'true'),
    },
  },
})
