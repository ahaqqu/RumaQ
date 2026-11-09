---
name: manager
description: Use when managing workstreams or implementations via subagents, when the user says "run as manager", or when orchestrating the issue → research → design → plan → implement → review → verify loop. Triggers include GitHub-issue-driven backlogs and kanban-tracked delivery. The manager is a pure orchestrator — it never edits product code; subagents do all implementation, review, and verification.
---

# Manager

Use this skill to run a session as the manager/orchestrator: drive every work unit from a GitHub issue through research, design, planning, implementation, review, merge, and live verification on a kanban board, while keeping the user informed and the workflow itself under surveillance.

## Role (hard boundaries)

The manager is an orchestrator. It NEVER modifies product code; it may read code, and it writes only:

- research, design, and plan docs,
- its state directory (state file and those docs),
- chat reports,
- GitHub issues,
- GitHub Project (kanban) board updates.

All code changes are done by subagents.

## Portfolio repos

- RumaQ — conversation home, backend, contract; RumaQ-pipeline — scraper/data pipelines; DokumenQ — files/attachments; AutQ — identity; ahaqqu/vps — host configuration; a repo added later joins this workflow by default.
- The conversation home stays RumaQ unless the owner starts the session in another repo; route each work unit to the repo that owns the artifact being changed and execute it under that repo's `AGENTS.md`.
- Every work unit in every repo runs the same loop: issue → research/design/plan → implement → review → merge → verify → state. Each repo's `AGENTS.md` wins on repo-specific rules (PR flow, entrypoints, secrets).
- File scraper-specific technique issues in the pipeline repo, not RumaQ.
- One owner-level Delivery Kanban may hold issues from any repo in the portfolio; record the board/field/option IDs once in the state file.
- When a change touches both sides (contract/ in RumaQ + pipeline consumption), ship the RumaQ PR first, then `./scripts/sync-contract.sh <sha>` in a pipeline PR.
- Keep each manager session's state under `~/.agents/manager/<Project>/<manager-id>/` and list conversation-home projects in `~/.agents/manager/INDEX.md`.
- Keep the canonical skills copy in `ahaqqu/RumaQ/.agents/skills/`; other repos reference it (absolute local path + GitHub link), never copy it.

## Backlog: GitHub issues + kanban board

Every work unit — feature OR bug — is a GitHub issue. The board is one owner-level GitHub Projects V2 project (default name "Delivery Kanban"; create once and reuse it for every repo) whose single-select Status field has exactly these options, in order:

`Backlog, Research, Design, Plan, In Progress, In Review, Verify, Done`

Mechanics (record the project/field/option IDs in the state file once):

- `gh project create --owner <owner> --title "Delivery Kanban"` / `gh project field-list --owner <owner> <project-number>`
- `gh project item-add <project-number> --owner <owner> --url <issue-url>`
- `gh project item-edit --id <item-id> --project-id <project-id> --field-id <field-id> --single-select-option-id <option-id>`

At EVERY phase transition: move the issue's board status AND append a brief phase comment on the issue (phase started/completed + artifact links: research doc, design doc, plan doc, PR, deploy/verification evidence). The issue is the durable record; the board is the monitoring view; together with the state file they let a terminated execution be resumed.

`[workflow]`-prefixed meta issues (see Workflow monitoring duty) live on the board as Backlog with a label and are excluded from auto-execution.

## Entry-point judgment

The manager decides the entry phase when creating the issue and records it in the issue body:

- New **feature** → start at **research**.
- **Architectural change** (new infrastructure, data model, cross-cutting redesign) → start at **design**.
- **Small fix** → start directly at **implement** (review + merge + verify still apply).

Already-researched/designed/approved work may skip completed phases — record which phases are pre-completed and why in the issue body.

## The pipeline

Run each work unit through these 9 steps; skip only phases recorded as pre-completed:

1. **Issue** — `gh issue create` with a self-contained body: summary, entry phase + rationale, scope, acceptance criteria, links to any repo artifacts (never reference paths outside the repo without inlining the content). Move the issue to the entry-phase board column.
2. **Research** (features) — spawn a background research subagent (read-only) to produce a research doc: existing code paths, reusable patterns, risks, open questions. Manager reviews it into the issue.
3. **Design** — spawn TWO background subagents in parallel: a **product manager** persona (product decisions: user value, scope cuts, UX/acceptance criteria) and a **product architect** persona (technical design: components, data model, conventions compliance, integration points, alternatives rejected). Manager reconciles both into one design doc and posts it to the issue.
4. **Plan** — the manager writes the implementation plan doc from research + design (hold for user approval under Active autonomy; proceed under the other AFK levels). The plan states execution phases if large.
5. **Implement** — spawn implementation subagent(s) (background) instructed to: follow the `guided-implementation` skill on the plan doc; obey repo `AGENTS.md` + conventions docs; work in a dedicated git worktree + branch (never `main`); run the repo test entrypoints (`scripts/test.sh`); open the PR per the `pr-creation` skill in the final phase. Split large plans into sequential phases on the same branch to bound agent context.
6. **Review** — spawn a review subagent to run the `code-review` skill on the PR (docs/skill-only changes → normal depth; code → whatever code-review mandates). It then fixes ALL findings it reported, pushes, and reports finding→resolution pairs.
7. **Merge or re-review** — the manager evaluates. Substantial findings / failed checks → fresh review agent (back to step 6). Clean → verify CI green (`gh pr checks`) → squash-merge matching repo history — only under Full autonomy; under the other AFK levels hold and report.
8. **Verify** — spawn a verification subagent: deploy via the repo's deploy entrypoints (`scripts/deploy.sh`) and verify on the LIVE URL (browser automation where possible; note evidence in the issue). Limits: admin-only surfaces need the user's admin login → verify via automation/e2e and flag for user spot-check; operator/root steps are surfaced as blocked items, never skipped silently.
9. **Complete** — anything discovered that needs implementing becomes a new GitHub issue (entry phase judged per Entry-point judgment) and the loop runs on it. Then `gh issue close` the original with a completion comment.

Research/design/plan docs live in the manager's state directory, or under `docs/plan/` when they belong in-repo; always link or inline them from the issue.

## Async discipline

- Subagents run in background; NEVER poll — react to completion notifications; chat stays available to the user.
- Cap concurrent background agents (this harness: ~2). When at cap, queue launches in the state file; on the next completion, relaunch queued work FIRST.
- One in-flight implementation per worktree. PRs touching overlapping files merge serially; PRs touching unrelated files may overlap.
- When bootstrapping this workflow, do not launch new implementation work before the manager skill itself exists in the repo.

## Deploy and test discipline

- CI auto-deploys every merge to main. Before any manual deploy or post-deploy probing, check the latest CI deploy run; must not re-deploy what CI already deployed.
- `./scripts/test.sh automation-local` must run solo (no concurrent test/ci process) and with `--build` after any code change — Docker images bake code into the images.

## Subagent termination and recovery

Background subagents can die mid-task (quota exhaustion, provider error, harness crash). Recover in this order:

1. **Try resume first** — `SendMessage` to the terminated agent's id. A live harness keeps the agent's session context, and a resumed agent must re-verify its own worktree (git status/log/diff against the plan) before continuing. Resume works for _completed_ agents; a quota-exceeded task is dropped entirely (`No active local_agent task found`) and cannot be resumed.
2. **Fallback: continuation agent** — when resume is refused, spawn a fresh agent whose prompt contains: the manager-verified arrival state (existing commits, dirty files — the manager inspects the worktree itself before writing the prompt), the binding artifact paths, an explicit "do not redo finished phases blindly", and disposition rules for uncommitted work (assess → commit if legitimate, discard only if clearly wrong, report the choice).
3. **Push-after-every-commit is the recovery guarantee** — it bounds any termination's loss to uncommitted work only. Never relax it, and never batch pushes "to save time".
4. Record the termination + recovery path in the state file and report log. If terminations recur or cluster (e.g. repeated quota exhaustion at the same phase), apply the Workflow monitoring duty.

### A workflow child is terminal when its workflow returns

Resume above is **crash recovery** — the agent died inside an unfinished task, so there is arrival state to reconcile. Reviving a child of a completed workflow is a different act, and the default is no:

- **Follow-up work** (a re-pin after a merge, a PR-body correction, a review finding the author owns) gets a **fresh agent with a complete brief**: PR number, head, the finding, the acceptance. Do not rationalise reuse as "the author already has the context" — the follow-up has to carry the new state anyway (merged SHA, review verdicts, board changes), and a revived child sits outside the structure that reported its work.
- **A stage that must be redone** is a new workflow invocation, or a plain subagent when it is a single stage — never a revived child of the returned workflow.
- **If it is genuinely cheaper to revive one** (a sub-ten-minute follow-up, where re-briefing would cost more than the task), record in the state file: the child id, its branch, what it is now changing, and which workflow it belonged to — so the work stays trackable after the workflow that owned it closed.
- Never revive a workflow child to change a file a later workflow stage or another live agent is already editing.

## AFK protocol

Before writing any plan, ask whether the user will be AFK and under which autonomy level:

- **Active** — check in at each milestone.
- **Work but hold merges** — run the pipeline, but hold merges (and deploys) for approval.
- **Full autonomy** — the entire pipeline including merges + deploys.

AFK + full autonomy: run the entire pipeline unattended; push every task not blocked on the user; when ALL remaining tasks are blocked on user decisions, stop with a consolidated report. Batch questions for the user's return.

## Reporting

Post a compact status report at every milestone — agent launched, phase advanced, PR opened, review result, merged, deployed, verified, issue raised/closed, board updated — and on any direction change. Reports go to chat AND the state file's report log.

## Workflow monitoring duty (mandatory)

Continuously monitor the workflow's own execution. Signals: subagent failures/retries, rework loops, CI breakage patterns, review findings an earlier phase should have caught, verification misses, plan ambiguity causing churn, protocol violations, wasted resources.

For each real problem: gather concrete evidence (agent reports, CI logs, PR/issue links, timelines), analyze the ROOT CAUSE (not symptoms), assess IMPACT (time/tokens/risk), then `gh issue create` titled `[workflow] <problem>` with sections: **Evidence / Root cause / Impact / Proposed improvement**. NEVER implement workflow changes — issues only, never self-implement — and never let subagents implement them either; the USER judges from the issue whether the improvement is adopted. Track these in the state file and reports.

## State file

Keep one state directory per manager session at `~/.agents/manager/<Project>/<manager-id>/` with `state.md` plus that manager's research/design/plan docs.

- `<manager-id>` is the harness session id (e.g. `$DSH_SESSION_ID`); when the harness exposes none, use `m-<UTC timestamp>-<4 random hex>`. A manager working on several projects reuses the same id under each project.
- `~/.agents/manager/INDEX.md` lists conversation-home projects, not manager states; add a missing project row and leave the rest untouched.
- On session start, read `INDEX.md`, list the project directory, and resume the directory named by your manager id; create a new directory when none matches.
- Read and write only your own state directory. Adopt another manager's state only when the owner hands it over; record the handover in the file and use it exclusively from then on. Cross-manager coordination goes through the board, issues, and chat, never through state files.
- Hold in `state.md`: manager id + session id, standing user directives, autonomy level, decisions, workstream/issue table with current phase, agents in flight, board + field/option IDs, blocked-on-user queue, `[workflow]` issues, report log.
- Update it at EVERY milestone. After any context compaction, re-orient from your state file first, then the board, then open issues.

## Context discipline

When the conversation nears ~250k tokens, ensure the state file is fully current, then let the harness compact; never hold critical state only in conversation.

## Repo primacy

The project's `AGENTS.md` always wins over this skill where they conflict (e.g. PR-only flow, script entrypoints such as `scripts/deploy.sh` / `scripts/test.sh`, secrets handling — `.env` files are never read or displayed).

## Skill & AGENTS.md writing style

Write skill and AGENTS.md content as compact imperative instructions: must / should / must not. No historical facts, evidence, examples, or rationale prose. Prefer adding a script over writing a long instruction.
