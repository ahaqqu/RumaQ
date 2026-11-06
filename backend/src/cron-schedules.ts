// The Worker's cron schedules — ONE source shared by the deploy config
// (cloudflare.config.ts's triggers array) and the runtime dispatch
// (gateway.ts's scheduled handler, which reads ScheduledController.cron to
// learn which schedule fired). Plain string constants, import-free, so both
// bundles can carry them without dragging a module graph along.
//
// TWO schedules since ticket 7 (#441), and the split is a hard subrequest
// constraint, not taste: the Workers free plan caps EVERY invocation (fetch
// AND scheduled) at 50 subrequests, and the core nightly tick's worst case
// is already 48/50 with ONE purge-capable plugin (plugin-purge.ts's
// accounting: 40 object deletes + 5 chunk statements + 1 work-set seek + 2
// sibling sweeps). Plugin-declared tasks get their OWN invocation — each
// cron trigger fires a separate scheduled event with a fresh per-invocation
// cap (multiple triggers per Worker are first-class config; the free plan
// allows three) — so the two workloads never compete for the same budget.
// Both stay off-peak UTC, like the original single trigger was.

/** The core nightly tick (#353 usage retention, #426 expiry sweep, #439
 * purge chunks) — the original schedule, unchanged. */
export const CORE_CRON_SCHEDULE = '17 3 * * *'

/** The plugin-tasks invocation (ticket 7, #441): gateway.scheduled dispatches
 * every plugin-declared cron task (lib/plugin-cron.ts) here, isolated from
 * the core tick's budget. */
export const PLUGIN_TASKS_CRON_SCHEDULE = '43 3 * * *'
