# Review auto-mode switch checklist (/admin/review)

Operational checklist for switching the match-review queue between `manual`,
`assist` and `auto` (ahaqqu/RumaQ#656). The evidence comes from
`scripts/review-queue-report.sh --remote`; the backlog-drain helper is
`scripts/review-evaluate.sh --remote`. Both scripts need the scoped script
token exported locally: `RUMAQ_REVIEW_TOKEN` (the api Worker's
`REVIEW_SCRIPT_TOKEN` secret — see MANUAL_ACTIONS in the owner's checkout;
never committed, never echoed).

## What auto mode does

- The review AI is a prompt through the household's `decision` capability
  (Settings → AI access). It is model-agnostic; each cached verdict records
  `provider` and `model`, so the reviewer can be changed without code.
- `manual` — no AI calls. `assist` — AI proposes, human decides (default).
  `auto` — the AI's verdict is applied when confidence ≥ 0.8
  (`REVIEW_AUTO_MIN_CONFIDENCE`); below that the item stays pending
  ("AI unsure").
- Verdicts are cached once per item (`review_ai_verdicts`). The cron sweep
  evaluates up to 20 items per tick; the on-demand route up to 10 per request
  (`REVIEW_EVALUATE_MAX`, the Workers subrequest cap).
- Taxonomy flags are self-pairs and are deliberately skipped by the AI.

## Before switching

1. Confirm AI is configured: open any pending row; a cached verdict chip must
   show a model. If it says "AI is not configured", set the decision
   capability first.
2. Run the read-only queue report (`scripts/review-queue-report.sh --remote`):
   - pending counts by reason (`price_ratio`, `verifier_unresolved`,
     `taxonomy`) — `counts.pendingByReason`;
   - AI coverage (`ai.pendingWithVerdict` / `ai.pendingWithoutVerdict`),
     provider/model mix (`ai.models`);
   - confidence distribution (`ai.confidenceBands`) and the auto-eligible
     count (`ai.autoEligible`, ≥ 0.8);
   - **agreement** on already-decided items (`agreement` — cached verdict
     vs human decision by confidence band: `same`↔approved,
     `different`↔rejected). This is the precision proxy; it needs no new
     review work.
3. Decide from the agreement, not from the AI's own confidence:
   - ≥ 95 % agreement at ≥ 0.8: auto is safe;
   - 85–95 %: auto is reasonable, but inspect the disagreements before/after;
   - < 85 %: stay in assist; fix the reviewer prompt/model or the input unit
     data (RumaQ-pipeline#119) first.

   If there are fewer than ~20 human-decided comparable pairs
   (`agreement[].decided`), spot-check 20 pending items (UI chips) and record
   the result before switching.

## Optional: drain the verdict backlog first

Assist caches verdicts without deciding them, so a bigger cached-verdict set
makes the agreement read stronger. `scripts/review-evaluate.sh --remote`
prints a dry-run snapshot; `--apply` drains pending-without-verdict items in
batches of 10, stopping on auth/quota (re-run to continue). It never decides
in `assist`/`manual` — but in `auto` the server applies cached verdicts
≥ 0.8, so drain **before** switching (each batch echoes the mode it ran in).

## Switch

1. Set the mode to `auto` on /admin/review. The change is audited through the
   mode row; a bounded sweep (10 items) starts immediately.
2. Watch one cron cycle: pending count must fall; `decided_source = ai_auto`
   rows appear; low-confidence rows stay pending.

## After switching

- Daily for the first week: re-run the report; watch agreement and the
  "disagreed" counts, and the pending count by reason.
- Review only the low-confidence pending items (the genuinely uncertain ones).
- Handle `taxonomy` flags separately — the identity AI never judges them.
- Rollback is a mode switch back to `assist` (or `manual`); auto decisions
  remain auditable and can be undone per item.

## Risks

- Auto decisions are live immediately; there is no merge/unmerge, so a wrong
  auto-approval is a data-quality defect, not a hidden one. Start with the
  agreement check, not with a blind switch.
- The AI's input is only as good as the unit data: RumaQ-pipeline#119
  (present-but-unparsed sizes) is the main known gap; pipeline #117/#120/#122
  reduce bad pairs.
- The script token is scoped to exactly the two review endpoints
  (`queue-report` GET, `evaluate` POST) and acts as the deployment's admin
  user — everything stays auditable through `decided_source`/`decided_by`.
  Rotate with `REVIEW_SCRIPT_TOKEN_NEXT`, same rule as the ingest secret.
