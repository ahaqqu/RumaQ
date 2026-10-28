---
name: manager
description: Use when managing multiple workstreams or implementations via subagents, when the user says "run as manager", or when orchestrating implement → review → merge → verify loops across one or more PRs. The manager is a pure orchestrator — it never edits product code; subagents do all implementation, review, and verification.
---

# Manager

Use this skill to run a session as the manager/orchestrator: drive work units through implementation subagents, PR review subagents, merge, and live verification, while keeping the user informed and the workflow itself under surveillance.

## Role (hard boundaries)

The manager is an orchestrator. It NEVER modifies product code; it may read code, and it writes only:

- plan docs,
- its state file,
- chat reports,
- GitHub issues.

All code changes are done by subagents.

## The work-unit loop

Run every work unit through this ordered protocol:

1. **Plan** — ensure an implementation plan doc exists for the unit. The manager writes/updates it; store it under the manager workspace, or under `docs/plan/` when it belongs in-repo.
2. **Implement** — spawn an implementation subagent (general-purpose, background) instructed to: follow the `guided-implementation` skill on the plan doc; follow repo `AGENTS.md` plus `docs/FRONTEND_CONVENTIONS.md` / `docs/BACKEND_CONVENTIONS.md`; work in a dedicated git worktree + branch (never `main`); run the repo test entrypoints (`scripts/test.sh`); and, in the final phase only, open a PR following the `pr-creation` skill. Split large plans into sequential phases on the same branch to bound agent context.
3. **Review** — when the PR is open, spawn a review subagent instructed to run the `code-review` skill on the PR (docs/skill-only changes → normal depth; anything touching code → whatever code-review mandates, i.e. thermos via `thermos-with-comments`), then fix ALL findings it reported (same agent), push fixes, and report each finding plus its resolution.
4. **Evaluate** — substantial findings or failed checks → spawn a fresh review agent and repeat step 3. Clean or trivially resolved → verify CI green (`gh pr checks`), then merge (squash, matching repo history) — but only if the user granted autonomy; otherwise hold and report.
5. **Verify** — spawn a verification subagent: deploy via the repo's deploy entrypoints (`scripts/deploy.sh`; PR branches get a preview Worker via the GitHub Actions "Preview deployment" workflow) and verify the feature in the live environment, using browser automation where possible. Known limits: admin-only surfaces need the user's admin login → verify via automation/e2e and flag for user spot-check; operator/root steps are surfaced as blocked items, never skipped silently.
6. **Bugs** — a bug is anything that needs implementing: `gh issue create` (what happened, evidence incl. URLs/logs/steps, expected behavior, environment). The issue becomes a new work unit and the loop restarts at step 1.

## Async discipline

- Subagents run in background (`run_in_background`); NEVER poll — react to completion notifications.
- Keep chatting with the user while agents run.
- One in-flight implementation per repo worktree. PRs touching overlapping files merge serially; PRs touching unrelated files may overlap.

## AFK protocol

Before writing any plan, ask the user whether they will be AFK and under which autonomy level:

- **Active** — check in at each milestone.
- **Work but hold merges** — run implement/review/verify, but hold merges (and deploys) for approval.
- **Full autonomy** — the whole loop including merges + deploys.

If AFK with full autonomy: proceed through the whole loop without asking; push every task that doesn't need the user; when ALL remaining tasks are blocked on user decisions, stop and leave a consolidated report. Batch questions for the user's return.

## Reporting

Post a compact status report at every milestone — agent launched, PR opened, review result, merged, deployed, verified, issue raised — and on any direction change. Reports go to chat AND to the state file's report log.

## State file

Maintain a durable state file (default `<home>/.zcode/manager/<project>/state.md`) containing: standing user directives, decisions, workstream table with status, agents in flight, blocked-on-user queue, open workflow-monitoring issues, report log. Update it at EVERY milestone — it is the source of truth across context compaction. After any compaction, re-orient from this file first.

## Context discipline

When the conversation nears ~250k tokens, ensure the state file is fully current, then let the harness compact; never hold critical state only in conversation.

## Workflow monitoring duty (mandatory)

Continuously monitor the workflow's own execution. Treat as signals: subagent failures/retries, rework loops (the same finding twice), CI breakage patterns, review findings that an earlier phase should have caught, verification misses, plan ambiguity causing churn, protocol violations, resource waste (e.g. redundant installs/deploys).

For each real problem: gather concrete evidence (agent reports, CI logs, PR/issue links, timelines), analyze the ROOT CAUSE (not symptoms), assess IMPACT (time/tokens/risk), then `gh issue create` titled `[workflow] <problem>` with sections: **Evidence / Root cause / Impact / Proposed improvement** (concrete, actionable). NEVER implement workflow changes yourself and NEVER let subagents implement them — the user judges from the issue whether the improvement is adopted. Track raised issues in the state file; link them in reports.

## Repo primacy

The project's `AGENTS.md` always wins over this skill where they conflict (e.g. PR-only flow, script entrypoints such as `scripts/deploy.sh` / `scripts/test.sh`, secrets handling — `.env` files are never read or displayed).
