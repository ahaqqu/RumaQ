// The core export seam (ahaqqu/RumaQ#440 — plugin architecture ticket 6,
// docs/plan/plugin-architecture.md §3.4). The mirror of lib/plugin-purge.ts
// for the capability that ships alongside it: core owns WHEN/authz — the
// owner-only catalog route, the 'export' capability check, and the per-
// archive file budget — and the plugin owns HOW (its index, its port, its
// archive shape) behind the PluginExportJob registration seam. Core never
// reaches into plugin internals for the bytes.
//
// The budget is the WHY of the chunked export: the Workers free plan caps
// EVERY invocation at 50 subrequests and each storage read and each D1
// statement is one, so one request can never stream a whole vault's bytes —
// but it can stream a budgeted archive, and the plugin's continuation
// cursor makes vaults bigger than one archive drain through sequential
// downloads (export's answer to the purge driver's nightly chunks; export
// stays a request because it is read-only — nothing to resume, only to
// re-request).

import { pluginManifestById } from '../plugins/manifests.js'
import { pluginRegistrations } from '../plugins/registry.js'
import { PluginExportCursorError } from '../plugins/types.js'
import type { PluginExportArchive } from '../plugins/types.js'
import { PluginNotFoundError } from './plugins.js'
import { requireOwner } from './households.js'
import type { Env } from '../types.js'

/**
 * The per-archive file budget — how many storage reads one export response
 * may spend (the plugin validates it can fit a whole document and trims to
 * whole documents). The accounting, every statement counted:
 *
 *   per archive  = 1 D1 read (propsAuthMiddleware's active-household
 *                  lookup — it runs before the route does)
 *                + 1 D1 read (requireOwner's membership lookup)
 *                + 1 D1 batch (the 'plugin_exported' receipt + the document
 *                  page) + 1 D1 read (the page's file rows)
 *                + ≤ 1 D1 read (the continuation probe — only an untrimmed
 *                  full page probes)
 *                + `maxFiles` storage reads (1 subrequest each)
 *
 *   worst case   = 40 files + 5 D1 = 45 < 50 (the free-plan cap).
 *
 * A vault with more than 40 files exports across sequential archives —
 * the cursor header chains them — rather than exceeding the invocation
 * budget mid-stream (a half-streamed zip is a corrupt file). Deployment-
 * plan-agnostic like PURGE_TICK_OBJECT_BUDGET: the free plan is the
 * binding constraint, and both budgets move together when that changes.
 */
export const EXPORT_ARCHIVE_FILE_BUDGET = 40

/** The named manifest does not declare the 'export' capability (409, the
 * PluginPurgeUnsupportedError twin — the catalog only offers what the
 * manifest declares). */
export class PluginExportUnsupportedError extends Error {
  constructor() {
    super('Plugin does not support export')
  }
}

/**
 * Resolve one archive of one plugin's export for the ACTIVE household:
 * owner-only (the exfiltration-sized payload — the whole household's
 * documents, including other members' uploads — is owner-tier, the same
 * posture as the purge this precedes; §3.4 routes delete through
 * export-first in the same owner-only lifecycle UI). Capability-checked
 * against the manifest, then dispatched through the registration seam.
 * The cursor (when the client continues a sequence) is validated by the
 * JOB — it carries the issuing household, and a foreign one is a 400,
 * never a silently wrong slice.
 */
export async function resolvePluginExport(
  env: Env['Bindings'],
  args: { householdId: string; userId: string; pluginId: string; cursor: string | null }
): Promise<PluginExportArchive> {
  const manifest = pluginManifestById(args.pluginId)
  if (!manifest) throw new PluginNotFoundError()
  if (!manifest.capabilities.includes('export')) throw new PluginExportUnsupportedError()

  await requireOwner(env.DB, args.householdId, args.userId)

  const job = pluginRegistrations(env).find((r) => r.manifest.id === manifest.id)?.export
  if (!job) throw new PluginExportUnsupportedError()

  // The job's cursor refusal (unknown / foreign-household cursor) rides the
  // shared plugin contract (PluginExportCursorError below) so it propagates
  // to the core route's onError untouched — core cannot import plugin-owned
  // error classes (§4.1 boundary), which is why the error lives in the
  // contract module both sides already share.
  return job({
    db: env.DB,
    householdId: args.householdId,
    actorUserId: args.userId,
    cursor: args.cursor,
    maxFiles: EXPORT_ARCHIVE_FILE_BUDGET,
  })
}

// Re-exported for the route's onError mapping — the contract-level error
// the plugin job throws and this seam lets through.
export { PluginExportCursorError }
