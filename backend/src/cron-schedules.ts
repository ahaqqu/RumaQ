// The Worker's cron schedules — ONE source shared by the deploy config
// (cloudflare.config.ts's triggers array) and the runtime dispatch
// (gateway.ts's scheduled handler, which reads ScheduledController.cron to
// learn which schedule fired). Plain string constants, import-free, so both
// bundles can carry them without dragging a module graph along.
//
// TWO schedules (the AI review sweep #484 is the second, and it is not a
// nightly tick — it runs every 30 minutes). The split is a hard subrequest
// constraint, not taste: the Workers free plan caps EVERY invocation (fetch
// AND scheduled) at 50 subrequests, and the core nightly tick's worst case is
// already 48/50 with ONE purge-capable plugin (plugin-purge.ts's accounting:
// 40 object deletes + 5 chunk statements + 1 work-set seek + 2 sibling
// sweeps). The AI review sweep gets its OWN invocation — each cron trigger
// fires a separate scheduled event with a fresh per-invocation cap — so the
// workloads never compete for the same budget. The nightly tick stays
// off-peak UTC, like the original single trigger was.
//
// Audit 2026-11-16 L14 deleted the third schedule (ticket 7's #441
// plugin-tasks handoff, lib/plugin-cron.ts): no manifest ever declared a cron
// task, so the nightly invocation was a no-op and the whole seam — driver,
// trigger, manifest field, validation — was dead code. The seam returns with
// the first real scheduled task.

/** The core nightly tick (#353 usage retention, #426 expiry sweep, #439
 * purge chunks) — the original schedule, unchanged. */
export const CORE_CRON_SCHEDULE = '17 3 * * *'

/** The AI match-review sweep (#484, backend PR 1): every 30 minutes,
 * gateway.scheduled evaluates a bounded batch of pending review items and
 * applies the verdicts that clear REVIEW_AUTO_MIN_CONFIDENCE — only in `auto`
 * mode (lib/review-ai.ts's runReviewAiSweep is the gate; manual/assist make
 * zero provider calls). Its own invocation means its ≤20 provider calls never
 * eat the core tick's 50-subrequest budget. The free plan allows three
 * triggers per Worker — this is the third. */
export const REVIEW_AI_CRON_SCHEDULE = '*/30 * * * *'
