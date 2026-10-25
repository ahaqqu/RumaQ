---
name: code-review
description: Use when reviewing a pull request after it is created. The single review entry point — sets the review depth (normal for docs/skill-only changes, thermos mandatory for anything touching code) and verifies philosophy and guardrail compliance.
---

# Code Review

Use this skill when reviewing a pull request after it has been created. It is the single entry point for all review: the thermo passes are reached through this skill — always via `.agents/skills/thermos-with-comments/SKILL.md`, which posts the itemized findings on the PR.

## Review depth (determined by the change, not negotiated)

- **Normal** — this skill's philosophy and guardrail review only. Allowed only when the PR touches **no code**: docs, skills, agent-instruction files, plans/ADRs, specs, and similar non-runtime surfaces.
- **Thermos (mandatory for code)** — if the diff touches any runtime code (`frontend/`, `backend/`, `automation/`, `scripts/`, `backend/migrations/`, `.github/workflows/`), run `.agents/skills/thermos-with-comments/SKILL.md`: run both thermo-nuclear passes (security/correctness + maintainability) yourself in the same session — no subagents — and post the itemized findings as PR comments. This is not optional and not a recommendation — a PR that changes code is always reviewed at thermos depth.

There is no third depth. If a PR mixes code and docs, thermos applies to the whole PR.

Findings land on the PR as itemized comments via `thermos-with-comments`. Per `AGENTS.md`, never merge the PR yourself — request human review, and the CI gate (`scripts/github/ci.sh`) must be green before merge.

## Inputs

- The pull request diff.
- `docs/ARCHITECTURE.md` — verify the changes align with the goals, constraints, and security checklist.
- `AGENTS.md` — verify the changes comply with guardrails.
- `docs/BACKEND_CONVENTIONS.md` and `docs/FRONTEND_CONVENTIONS.md` — verify the changes follow the coding conventions.

## Philosophy alignment

RumaQ's goals and constraints are defined in `docs/ARCHITECTURE.md` §1. For each, check if the PR upholds or violates it:

- **Low friction**: Does the PR make the photo → stock flow harder? Does it promote manual logging from fallback to default? Does it add steps to the happy path?
- **Cheap to run**: Does the PR risk the Cloudflare free-tier limits (Workers 100k req/day, D1 500 MB / 100k queries/day, R2 10 GB, Pages 500 builds/mo)? Does it add paid services or paid dependencies?
- **Privacy first**: Could the PR expose the user's AI key or personal data? Do AI prompts avoid other users' data and internal DB IDs? Do receipt images still flow only through the Worker proxy (no direct R2 access from the frontend)?
- **Fast and local-feeling**: Does the PR keep the UI optimistic with loading states that name the work? Are cache directives correct — `public, max-age=60` only for public GETs, `private, no-cache` for anything authenticated? Does it block the UI on network where it needn't?

## Guardrail compliance

For each changed file, verify against `AGENTS.md`, the conventions docs, and the architecture security checklist:

Backend (`docs/BACKEND_CONVENTIONS.md`):

- Valibot validates all route inputs (params, query, body) with consistent validation error shapes.
- New domain apps follow the gateway wiring; route handlers stay HTTP-focused with business logic extracted into services or helpers.
- D1 is accessed through the bound environment; queries are parameterized; related writes batch in a single transaction; query results are typed, not loosely cast.
- Auth goes through the existing session/JWT middleware and auth helpers — never re-implemented; the OAuth PKCE flow and `state` validation stay intact; email/password auth stays behind `EMAIL_AUTH_ENABLED`.
- Cache headers go through shared helpers; public routes cacheable, authenticated routes `private, no-cache`.
- Errors use the consistent error shape and shared handler; raw internal error messages are never exposed to clients in production.
- Route changes are annotated with `describeRoute` (hono-openapi) and `docs/API.md` is regenerated via `./scripts/docs.sh` — never hand-edited.
- CORS allows only known origins; cookies stay `httpOnly`, `secure`, with an appropriate `sameSite`; auth and sensitive endpoints keep rate limiting; production responses carry security headers.
- Every household-scoped D1 query filters by `household_id` or `user_id`.

Frontend (`docs/FRONTEND_CONVENTIONS.md`):

- Styling uses Tailwind v4 utilities, the project's design tokens, and the conditional class helper — no ad-hoc styling or runtime CSS-in-JS.
- Project UI components and shared icon exports are preferred over custom HTML primitives.
- Navigation uses file-based routing and the router's navigation primitives — no native links or manual URL manipulation.
- Data flows through the project's server-state hooks; server state is invalidated after successful mutations; optimistic updates use snapshot/rollback; shared contexts only for cross-cutting client state.
- Auth relies on the existing auth query/mechanism; PWA updates use the existing update prompt — no custom service worker logic.

Cross-cutting:

- User-facing strings live in `frontend/src/i18n/locales/en.json` and `id.json` (react-i18next) — no hardcoded copy.
- Secrets stay in Worker secrets or gitignored `backend/.dev.vars`; nothing committed; `.env` files are never read or displayed.
- Deploys go through `scripts/deploy.sh` and tests through `scripts/test.sh`; new shell scripts are added to `.gitattributes` with `mode=755`.
- Dependencies are public, trusted libraries and free-tier compatible; heavy dependencies are avoided where a small helper or built-in Web API suffices.
- Changes come through PRs (never directly to `main`), the CI gate (`scripts/github/ci.sh`) is green before merge, and new endpoints/UI flows have automation scenarios per `docs/TEST_STRATEGY.md`.

## Posting contract (any PR comment, incl. thermos findings)

- **One individual review comment per finding.** Each finding exists as its own review comment carrying a stable ID; a summary comment may index the items but must never be the only place a finding exists. Dispositions thread on the original comment.
- **Line-anchored by default.** Any finding with a locatable anchor must be an inline review comment on its file and line, resolved via the diff (`gh pr diff --patch` → diff position), and must quote or reference the offending line so the thread is self-contained.
- **PR-level fallback is justified, not silent.** Reserve PR-level comments for genuinely unanchorable findings (cross-cutting, process notes); the comment itself must open with the justification, e.g. "no single anchorable line: …".
- **Stale pending-draft preflight.** GitHub allows one pending review per user per pull request (its 422 text: "user_id can only have one pending review per pull request"); a stale PENDING review draft under the authenticated account forces 422s on review-comment creation. Before posting itemized comments, list `gh api repos/{owner}/{repo}/pulls/{n}/reviews`, and delete any PENDING draft (`gh api -X DELETE repos/{owner}/{repo}/pulls/{n}/reviews/<review_id>`).

## Output

Report:

- Philosophy violations: which goal/constraint is violated, which file, and why.
- Guardrail violations: which rule is broken, which file and line.
- Thermo findings (when code was touched): the itemized report posted by thermos-with-comments (A/B/C IDs), merged and prioritized.
- Approval or rejection with justification.

Recommend blocking the PR (request-changes) on any security, correctness, or guardrail violation that must be fixed before merge; flag convention deviations as discussion points for author response. Per `AGENTS.md`, the PR merges only after the CI gate is green and a human approves — never merge it yourself.
