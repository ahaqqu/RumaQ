// Minimal structured logging: ISO-prefixed lines to stdout, rejected items
// also appended to rejected-items.log in the state dir (docs/plan §6 — the
// review queue UI is replaced by this log on the VPS).

import { appendFile } from 'node:fs/promises'
import path from 'node:path'

export type LogFn = (message: string) => void

export function createLog(label: string): LogFn {
  return (message: string) => {
    process.stdout.write(`${new Date().toISOString()} [${label}] ${message}\n`)
  }
}

export async function logRejectedItem(
  stateDir: string,
  entry: { storeSlug: string; imageFilename: string; name?: string; reason: string }
): Promise<void> {
  const line = `${new Date().toISOString()}\t${entry.storeSlug}\t${entry.imageFilename}\t${entry.name ?? '-'}\t${entry.reason}\n`
  await appendFile(path.join(stateDir, 'rejected-items.log'), line, 'utf8')
}
