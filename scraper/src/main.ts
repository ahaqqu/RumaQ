// CLI entry — scrapes new brochure pages, OCRs them, matches against the
// canonical catalog, and publishes a price snapshot (dry-run until go-live).
// Exit codes: 0 ok, 1 failure, 2 quota.
//
//   bun src/main.ts [--publish] [--self-check] [--state-dir=DIR]
//
// --publish may also come from RUMAQ_PUBLISH=true in the environment (the
// systemd unit's go-live switch: no unit edit, one env line as root).
// --self-check is the post-deploy gate (provision/vps/deploy path).

import { Effect } from 'effect'

import { runPipeline } from './pipeline.js'
import { runSelfCheck } from './selfcheck.js'

function parseArgs(argv: string[]): { publish: boolean; selfCheck: boolean; stateDir: string } {
  const selfCheck = argv.includes('--self-check')
  const publish =
    argv.includes('--publish') || ['1', 'true', 'yes'].includes(process.env.RUMAQ_PUBLISH ?? '')
  const stateDirArg = argv.find((arg) => arg.startsWith('--state-dir='))
  return {
    publish,
    selfCheck,
    stateDir: stateDirArg
      ? stateDirArg.slice('--state-dir='.length)
      : (process.env.RUMAQ_SCRAPER_STATE_DIR ?? 'state'),
  }
}

const args = parseArgs(process.argv.slice(2))

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
  const program = runPipeline({ stateDir: args.stateDir, dryRun: !args.publish }).pipe(
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
      process.stderr.write(`${String(error)}\n`)
      process.exit((error as { exitCode?: number }).exitCode ?? 1)
    }
  )
}
