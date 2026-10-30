// CLI entry — scrapes new brochure pages, OCRs them, matches against the
// canonical catalog, and publishes a price snapshot (dry-run until go-live).
// Exit codes: 0 ok, 1 self-check/usage failure (the post-deploy gate), and
// the pipeline's real exit code for scoped runs.
//
//   bun src/main.ts [--publish] [--self-check] [--state-dir=DIR] [--stores=slug1,slug2]
//
// --publish may also come from RUMAQ_PUBLISH=true in the environment (the
// systemd unit's go-live switch: no unit edit, one env line as root).
// --self-check is the post-deploy gate (vps-deploy rumaq's health_unit).
// --stores scopes a run to the given slugs (docs/plan/scrape-now.md §2) —
// that is the on-demand path the scrape agent drives.
//
// A failed NIGHTLY run exits 0 on purpose: the failure is logged to the
// journal and recorded in status.json (the pipeline still carries its own
// exit code 1/2 internally), the systemd unit stays green, and the timer
// simply retries tomorrow. Seven consecutive failed nights trip the
// freshness gate instead (scripts/github/check-price-freshness.sh) — that,
// not one bad run, is the service-down signal. A scoped (--stores) run must
// NOT soft-exit: the scrape agent depends on the real exit code to finish
// its command failed, so scoped failures exit 1/2. The deploy-time
// self-check still exits 1 so a tree that cannot run fails its deploy.

import { Effect } from 'effect'

import { parseArgs } from './args.js'
import { PipelineFailure, runPipeline } from './pipeline.js'
import { runSelfCheck } from './selfcheck.js'

const args = parseArgs(process.argv.slice(2))

if (args.storesError) {
  process.stderr.write(`[scraper] ${args.storesError}\n`)
  process.exit(1)
}

if (args.selfCheck) {
  // The unit's journal is the only place a failed deploy explains itself —
  // never run this silent.
  Effect.runPromise(
    runSelfCheck({
      stateDir: args.stateDir,
      publish: args.publish,
      log: (message) => process.stdout.write(`${message}\n`),
    })
  ).then(
    (results) => {
      const failed = results.filter((result) => !result.ok)
      process.exitCode = failed.length > 0 ? 1 : 0
    },
    (error) => {
      process.stderr.write(`${String(error)}\n`)
      process.exitCode = 1
    }
  )
} else {
  const program = runPipeline({
    stateDir: args.stateDir,
    dryRun: !args.publish,
    stores: args.stores,
  }).pipe(
    Effect.tap((status) =>
      Effect.sync(() => {
        for (const [slug, entry] of Object.entries(status.stores)) {
          process.stdout.write(
            `${slug}: ${entry.pagesFound} pages, ${entry.newImages} new, ` +
              `${entry.existingImages} existing, ${entry.itemsExtracted} items, ${entry.itemsRejected} rejected\n`
          )
        }
        if (status.match) {
          process.stdout.write(
            `match: ${status.match.exact} exact, ${status.match.embedding} embedding, ` +
              `${status.match.ai} ai, ${status.match.solo} new, ${status.match.reviewItems} review\n`
          )
        }
      })
    )
  )

  Effect.runPromise(program).then(
    () => process.exit(0),
    (error) => {
      if (args.stores) {
        // Scoped runs report the pipeline's REAL exit code — the scrape
        // agent finishes its command failed with it. See the header.
        const exitCode = error instanceof PipelineFailure ? error.exitCode : 1
        process.stderr.write(`[scraper] scoped run failed (exit ${exitCode}): ${String(error)}\n`)
        process.exit(exitCode === 2 ? 2 : 1)
      }
      // Soft on purpose — see the header: a failed nightly run is logged
      // (journal + status.json) and retried by tomorrow's timer, not turned
      // into a failed unit that flags the box's shared doctor.
      process.stderr.write(
        `[scraper] nightly run failed (logged + reported; retrying next scheduled run): ${String(error)}\n`
      )
      process.exit(0)
    }
  )
}
