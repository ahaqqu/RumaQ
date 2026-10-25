// CLI entry — scrapes new brochure pages, OCRs them, and publishes a price
// snapshot (dry-run by default in PR2). Exit codes: 0 ok, 1 failure, 2 quota.

import { runPipeline } from './pipeline.js'

function parseArgs(argv: string[]): { publish: boolean; stateDir: string } {
  const publish = argv.includes('--publish')
  const stateDirArg = argv.find((arg) => arg.startsWith('--state-dir='))
  return {
    publish,
    stateDir: stateDirArg
      ? stateDirArg.slice('--state-dir='.length)
      : (process.env.RUMAQ_SCRAPER_STATE_DIR ?? 'state'),
  }
}

const args = parseArgs(process.argv.slice(2))

try {
  const status = await runPipeline({ stateDir: args.stateDir, dryRun: !args.publish })
  for (const [slug, entry] of Object.entries(status.stores)) {
    process.stdout.write(
      `${slug}: ${entry.pagesFound} pages, ${entry.newImages} new, ` +
        `${entry.existingImages} existing, ${entry.itemsExtracted} items, ${entry.itemsRejected} rejected\n`
    )
  }
  process.exit(0)
} catch (error) {
  process.stderr.write(`${String(error)}\n`)
  process.exit((error as { exitCode?: number }).exitCode ?? 1)
}
