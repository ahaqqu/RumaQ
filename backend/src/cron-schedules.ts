// The Worker's cron schedules — ONE source shared by the deploy config
// (cloudflare.config.ts's triggers array) and the runtime dispatch
// (gateway.ts's scheduled handler, which reads ScheduledController.cron to
// learn which schedule fired). Plain string constants, import-free, so both
// bundles can carry them without dragging a module graph along.
//
// THREE schedules (two since ticket 7, #441; the AI review sweep #484 added
// the third, and it is not a nightly tick — it runs every 30 minutes). The
// split is a hard subrequest constraint, not taste: the Workers free plan caps
// EVERY invocation (fetch AND scheduled) at 50 subrequests, and the core
// nightly tick's worst case is already 48/50 with ONE purge-capable plugin
// (plugin-purge.ts's accounting: 40 object deletes + 5 chunk statements + 1
// work-set seek + 2 sibling sweeps). Plugin-declared tasks and the AI review
// sweep each get their OWN invocation — each cron trigger fires a separate
// scheduled event with a fresh per-invocation cap (multiple triggers per
// Worker are first-class config; the free plan allows three) — so the
// workloads never compete for the same budget. The two nightly ticks stay
// off-peak UTC, like the original single trigger was.

/** The core nightly tick (#353 usage retention, #426 expiry sweep, #439
 * purge chunks) — the original schedule, unchanged. */
export const CORE_CRON_SCHEDULE = '17 3 * * *'

/** The plugin-tasks invocation (ticket 7, #441): gateway.scheduled dispatches
 * every plugin-declared cron task (lib/plugin-cron.ts) here, isolated from
 * the core tick's budget. */
export const PLUGIN_TASKS_CRON_SCHEDULE = '43 3 * * *'

/** The AI match-review sweep (#484, backend PR 1): every 30 minutes,
 * gateway.scheduled evaluates a bounded batch of pending review items and
 * applies the verdicts that clear REVIEW_AUTO_MIN_CONFIDENCE — only in `auto`
 * mode (lib/review-ai.ts's runReviewAiSweep is the gate; manual/assist make
 * zero provider calls). Its own invocation means its ≤20 provider calls never
 * eat the core tick's 50-subrequest budget. The free plan allows three
 * triggers per Worker — this is the third. */
export const REVIEW_AI_CRON_SCHEDULE = '*/30 * * * *'
