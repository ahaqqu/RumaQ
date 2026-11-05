# RumaQ — Live QA Workflow

Standing workflow for live exploratory QA passes against **production**
(https://rumaq.ahaqqu.com). Established by QA run 2026-11-04-01
(ahaqqu/RumaQ#402); that ticket is the reference example of every artifact
below.

This is an **optional** step, not part of CI: run it after a significant
feature ships (new surface, new migration, auth/authorization change), or on
demand from the owner. It complements — never replaces — `docs/TEST_STRATEGY.md`
and the local/live automation suites.

## 1. Trigger and tracking ticket

- Trigger: optional step after significant features, or on demand.
- **One tracking ticket per run**, titled `QA run YYYY-MM-DD-NN — <short
  description>`. The ticket holds the run's purpose, target build, safety
  rules, process contract, and acceptance checkboxes, and is the only place
  results are posted (one results comment per run — no scatter).
- The run closes when the manager's triage is recorded on the ticket.

## 2. QA persona and briefing template

The pass is executed by a QA-engineer subagent (meticulous,
adversarial-but-safe, evidence-driven). Briefing template:

```
Persona: QA engineer — meticulous, adversarial-but-safe, evidence-driven.
Target: <live URL> — build <sha/features deployed>. REAL app, REAL family data.
Tracking ticket: <issue URL> — read first; safety rules there are absolute.
Auth: sanctioned live smoke account <account> (checked into
automation/tests/live/e2e/login.spec.js). Fresh-account registration
behavior is itself a test question.
Tooling: repo Playwright (@playwright/test) + automation/playwright.live.config.js;
scratch scripts ONLY under /tmp/qa-run-<N>/; never modify tracked files.
Time-box: ~45–60 min active testing, ~75 min total; report honestly what
was not covered.
Deliverable: ONE results comment on the ticket (format in docs/QA.md §7),
plus the standing-workflow docs PR if the workflow itself changed.
```

## 3. Scope template

Positive (real user flows, read-only if no sandbox):

- Login happy path; all nav sections render.
- New-feature surfaces render and behave (e.g. document vault panel, two-mode
  member add UI).
- Gates render correctly (admin screens for non-operators).
- Service-worker install/activate and cache headers (PWA freshness).

Negative (each probe needs an expected response named up front):

- Auth: fresh-account registration probe, wrong password (+ no lockout-bypass),
  logout → back-button resurrection, tampered session cookie (flip a char,
  verify 401 **with a valid-cookie control** in the same harness).
- Authorization: cross-household/cross-document probes with random UUIDs on
  GET **and** write methods — expect 404 with generic bodies, never 403/200
  (no existence leak); admin API with a user session → 403.
- Unauthenticated: `/api/*` → 401; protected routes → login redirect.
- Input validation: oversize upload (>cap), magic-byte/extension mismatch,
  whitespace-only required fields, invalid invite/join codes.
- Console sweep: collect page console errors for the whole run; unexpected
  frontend console errors are findings (S3/S4).

## 4. Safety rules (the contract — absolute)

- QA may create/modify/delete ONLY entities it created itself, prefixed `QA-`.
- NEVER touch pre-existing family data — read-only browsing allowed, no
  edits/deletes of anything not QA-created. The smoke account's baseline
  household is used by production smoke tests: no state changes there.
- No load/perf testing; human-pace interactions only.
- Never read/display `.env` contents (names only); no secrets in evidence;
  evidence (screenshots/traces) stays out of git.
- If a test would be destructive beyond QA's own sandbox, skip and document.
- Rejected operations (validation failures, 4xx) are fair game even in the
  smoke account's context, because they persist nothing — verify the
  nothing-persisted claim after each probe.

## 5. Auth strategy

The sanctioned live smoke account (currently `alice@rumaq.dev`, checked into
`automation/tests/live/e2e/login.spec.js`) is for **read-only browsing +
negative-only probes**. The first empirical question of every run decides the
mode:

1. **Sandbox probe**: attempt login with a fresh `qa-<epoch>@<domain>`
   address + strong random password. If the form auto-registers → QA owns a
   sandbox household → run full positive flows there first (baseline, member
   add, document upload/view/download/filter/delete, inventory add-delete,
   settings), then the negative suite.
2. **Registration closed** (current state: "Invalid email or password", no
   enumeration leak) → fall back to the smoke account strictly read-only +
   negative-only. Positive flows are then limited to rendering/behavior of
   existing state; anything that must persist is listed as Untestable.
   Server-side validation that persists nothing on rejection (413/415 upload
   policy, 404-before-leak) can still be exercised directly against the API
   with the smoke session.
3. Never create accounts or data outside the `QA-` prefix contract, and never
   persist markers into the smoke household.

## 6. Evidence policy

- Screenshots, traces, console logs, and Playwright results go to
  `/tmp/qa-run-<N>/evidence/` — never into the repo.
- Scratch specs live in `/tmp/qa-run-<N>/`; tracked files are never modified
  by a QA run.
- Reference evidence by absolute path in the results comment.
- No secrets, tokens, cookie values, or `.env` contents in evidence or
  comments (cookie _metadata_ such as length/expiry is fine).
- End-of-run hygiene: log the smoke account out; if a session token remains
  server-valid (see QA-F2 on ticket #402), disclose it in the cleanup
  statement.

## 7. Results comment format (one comment per run)

Post exactly this structure on the tracking ticket:

1. **Verdict line**: PASS / PASS-WITH-FINDINGS / FAIL + one-paragraph
   executive summary.
2. **Environment**: live build markers verified (routes, version, SW
   behavior), tooling, evidence location.
3. **Positive results**: table (flow, result, notes).
4. **Negative results**: table (probe, expected, actual, verdict).
5. **Findings**: `QA-F1`, `QA-F2`… each with severity — S1 (blocker/security),
   S2 (major), S3 (minor), S4 (nit) — area, evidence-based repro steps, and a
   suggested disposition (bug ticket / quick fix / by-design / needs decision).
6. **Untestable + why** (e.g. OAuth, admin-only screens, second account,
   email delivery, stale-SW upgrade path).
7. **Cleanup statement**: exactly what QA state remains on live (goal:
   only clearly `QA-`-prefixed entities in a QA-owned household, or nothing).

## 8. Manager triage

After the results comment lands, the manager triages each finding:

- **Bug** → its own ticket with the severity and repro from the finding.
- **Quick fix** → implementation workflow: implement → thermos review → PR.
- **Needs product decision** → pending owner, noted on the ticket.
- **Infra/env gap** → owner action item (e.g. missing test account, missing
  edge-side rate limiting).
  Owner action items are written to `docs/MANUAL_ACTIONS.md` (numbered ID,
  step-by-step, location-labeled) and referenced by ID from the triage
  comment; the manager updates the file as the owner reports progress.
- **No action** → note the disposition on the ticket (e.g. by-design).

### Merge authority

**Workflow ticket PRs are ALWAYS merged by the owner, never by the
manager/agents — even when the owner is AFK.** The corollary: the manager
reviews the QA docs PR (the run's `docs/QA.md` / AGENTS.md process-line
changes), posts any findings as review comments, but leaves the merge button
to the owner. A QA run is not closed by merging its docs PR; it is closed by
recorded triage.
