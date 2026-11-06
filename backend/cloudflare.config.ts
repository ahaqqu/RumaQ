import { bindings, defineConfig, triggers } from 'cf/config'
// The two cron strings (ticket 7, #441) — one source shared with gateway.ts's
// dispatch. This module is import-free constants by design, so the config
// bundle carries it without dragging a module graph along. The .ts extension
// is deliberate: BOTH consumers of this config — the cf CLI and
// @cloudflare/vite-plugin — load it through Node's native ESM resolver
// (registerConfigHooks: type-stripping, no .js → .ts extension rewriting), so
// a .js specifier would fail in both; .ts is the only specifier both resolve.
import { CORE_CRON_SCHEDULE, PLUGIN_TASKS_CRON_SCHEDULE } from './src/cron-schedules.ts'

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
 * Secrets are declared as deployment-only placeholders (bindings.secret()):
 * values are set per-environment via `cf workers secrets update` (see
 * scripts/deploy.sh) in production and read from backend/.dev.vars in local
 * dev. Without a declaration the Vite plugin never injects .dev.vars values,
 * so local dev runs with undefined secrets.
 */

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'LOCAL'
// Local/dev/test placeholder. Must be a v4-shaped UUID: cf CLI rejects the nil
// UUID, and this same value keys the local D1 state for both the Vite plugin
// and `cf d1 migrations apply --local`.
const LOCAL_DATABASE_ID = '00000000-0000-4000-8000-000000000000'
const databaseId = process.env.CLOUDFLARE_DATABASE_ID ?? LOCAL_DATABASE_ID
const databaseName = process.env.D1_DATABASE_NAME ?? 'rumaq'
const bucketName = process.env.R2_BUCKET_NAME ?? 'rumaq-receipts'
// Brochure images (issue #293): a separate bucket from receipts — different
// retention law (referenced-set sweep with a 14-day grace) and blast radius.
const brochuresBucketName = process.env.R2_BROCHURES_BUCKET_NAME ?? 'rumaq-brochures'

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
    // deploy time (branch deploys keep their *.workers.dev URL only). This
    // requires the ahaqqu.com zone to stay in this Cloudflare account — the
    // zone was migrated from registrar DNS (mysrsx) for exactly this purpose;
    // if the zone is ever removed again, deploys fail on zone inference.
    domains: isProduction ? ['rumaq.ahaqqu.com'] : undefined,
    // Single-deploy topology: the Worker serves both the SPA (frontend build,
    // wired in via publicDir in vite.config.ts) and the API. API requests must
    // always reach the user worker; unknown paths fall back to index.html.
    assets: {
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*'],
    },
    // TWO cron schedules (ticket 7, #441 — the strings live in
    // src/cron-schedules.ts, shared with gateway.ts's dispatch, which reads
    // ScheduledController.cron). Each trigger fires its OWN scheduled
    // invocation with its OWN per-invocation subrequest cap (50 on the free
    // plan; the free plan allows three triggers per Worker):
    //
    //   CORE_CRON_SCHEDULE — the original nightly tick, unchanged: #353 usage
    //   retention, #426 expiry sweep, #439 purge chunks (worst case 48/50
    //   with one purge-capable plugin — plugin-purge.ts's accounting).
    //
    //   PLUGIN_TASKS_CRON_SCHEDULE — the generalized plugin-task handoff
    //   (#441, lib/plugin-cron.ts), isolated from the core tick's budget by
    //   being its own invocation; a no-op nightly until a plugin declares a
    //   task. Both schedules stay off-peak UTC.
    triggers: [
      triggers.scheduled({ schedule: CORE_CRON_SCHEDULE }),
      triggers.scheduled({ schedule: PLUGIN_TASKS_CRON_SCHEDULE }),
    ],
    // Workers Logs persistence (#451): keeps structured ingest-rejection lines
    // queryable in the dashboard instead of dying with the invocation logs.
    observability: { enabled: true },
    env: {
      DB: bindings.d1({ name: databaseName, id: databaseId }),
      RECEIPTS: bindings.r2({ name: bucketName }),
      // Document vault (issue #388): the SAME private bucket as RECEIPTS under
      // a dedicated binding — the vault's keys carry the documents/ prefix
      // (plugins/documents/keys.ts), so no new infrastructure and no shared code path.
      // Swapping to the #391 file service later changes only this binding and
      // the StorageAdapter implementation.
      DOCUMENTS: bindings.r2({ name: bucketName }),
      BROCHURES: bindings.r2({ name: brochuresBucketName }),
      ASSETS: bindings.assets(),
      EMAIL_AUTH_ENABLED: bindings.text('true'),
      // Startup secrets check only makes sense against a real account; local
      // dev runs on placeholder secrets from .dev.vars.
      RUN_SECRETS_CHECK: bindings.text(accountId === 'LOCAL' ? 'false' : 'true'),
      // Required by gateway.ts's startup check. Optional secrets
      // (HAQITA_INGEST_SECRET, RUMAQ_SERVER_AI_*) stay undeclared so local
      // dev without them does not warn.
      GOOGLE_CLIENT_ID: bindings.secret(),
      GOOGLE_CLIENT_SECRET: bindings.secret(),
      WORKER_JWT_SECRET: bindings.secret(),
      WORKER_ENCRYPTION_KEY: bindings.secret(),
    },
  },
})
