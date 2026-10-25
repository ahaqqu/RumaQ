# Phase 12 — Product Foundation

**Status:** Done (PR #260 — CONTRIBUTING.md, onboarding, GitHub templates, conventions checklists, AGENTS.md review)  
**Priority:** P2  
**Source sections:** Section 1 of `docs/PROJECT_PLAN.md`  
**Estimated effort:** Low

---

## Objective

Complete the project foundation documentation so new contributors and agents can onboard quickly. Add a `CONTRIBUTING.md` and update `AGENTS.md` (already exists) to reflect the current conventions. The user impact is indirect: _a healthier project that is easier to maintain and contribute to_.

This is P2 and can happen after the MVP, but it is small and should be done before the project grows much.

---

## Acceptance Criteria

1. `CONTRIBUTING.md` exists at the repo root and covers: project overview, prerequisites, setup, development workflow, testing, branching, PR process, code style, and how to ask questions.
2. `AGENTS.md` is reviewed and updated if it no longer matches the actual conventions or scripts.
3. `docs/FRONTEND_CONVENTIONS.md` and `docs/BACKEND_CONVENTIONS.md` are reviewed and cross-linked from `CONTRIBUTING.md`.
4. A `docs/ONBOARDING.md` or section in `README.md` exists for first-time setup.
5. Issue and PR templates are added or updated in `.github/`.
6. All foundation docs are consistent and up to date with the current project structure.
7. `vp test` and `vp check --no-fmt --no-lint` pass (no code changes expected).

---

## Dependencies

- Phases 01-05 for the actual conventions to document.
- Existing `AGENTS.md`, `docs/FRONTEND_CONVENTIONS.md`, `docs/BACKEND_CONVENTIONS.md`, `README.md`.
- Existing scripts in `scripts/`.

---

## Scope

### 1. CONTRIBUTING.md

Create `CONTRIBUTING.md` with the following sections:

- **Welcome** — brief project purpose and values.
- **Prerequisites** — Node.js version, Wrangler, Docker (for tests), Cloudflare account (for deployment).
- **Setup** — clone, install, run locally (`vp run dev` or Wrangler), run tests.
- **Development workflow** — branch naming, commit message style, PR process, required checks.
- **Testing** — how to run unit tests, integration tests, E2E tests, and smoke tests. Reference `docs/TEST_STRATEGY.md`.
- **Code style** — reference `docs/FRONTEND_CONVENTIONS.md` and `docs/BACKEND_CONVENTIONS.md`.
- **Architecture** — brief pointer to `docs/ARCHITECTURE.md` and `docs/API.md`.
- **Deployment** — pointer to `docs/ARCHITECTURE.md` and `scripts/deploy.sh`.
- **Security** — pointer to security checklist/docs.
- **How to ask questions** — GitHub issues or discussions.
- **License** — if applicable, reference the license file.

### 2. Review and update AGENTS.md

- Read `AGENTS.md` and verify it matches the current project.
- Update any outdated paths, script names, or conventions.
- Add a note about reading `docs/plan/*.md` when asked to implement a phase.
- Ensure it does not contain duplicated content that belongs in `CONTRIBUTING.md`.

### 3. Cross-link conventions

- In `docs/FRONTEND_CONVENTIONS.md`, add a quick-start checklist for new frontend changes.
- In `docs/BACKEND_CONVENTIONS.md`, add a quick-start checklist for new backend changes.
- Add a "Contributing" section to `README.md` linking to `CONTRIBUTING.md`.

### 4. GitHub templates

- Add `.github/PULL_REQUEST_TEMPLATE.md` with:
  - What changed and why.
  - How to test.
  - Checklist (tests, docs, typecheck, lint).
  - Screenshots if UI changed.
- Add `.github/ISSUE_TEMPLATE/bug_report.md` and `.github/ISSUE_TEMPLATE/feature_request.md` if not already present.

### 5. Onboarding guide

- Create `docs/ONBOARDING.md` or add a section to `README.md` with:
  - First-time setup commands.
  - How to run the local Worker and frontend together.
  - How to log in with email auth for local testing.
  - Common issues and fixes.

---

## Out of Scope

- Code of Conduct (can be added later if community grows).
- Governance model.
- Financial/sponsorship documentation.
- Changelog automation (can be added later).
- Release process beyond `deploy.sh`.

---

## Database Changes

None.

---

## Testing Strategy

- No code changes; verify docs by reading them.
- Optionally run `markdownlint` or a similar tool if available.
- Ask someone not familiar with the project to follow the onboarding steps and report gaps.

---

## Deployment & Secrets

None.

---

## Risks & Mitigations

| Risk                                     | Impact | Mitigation                                                                               |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| Documentation becomes outdated quickly   | Medium | Mention specific files by pattern rather than exact line numbers; review docs quarterly. |
| CONTRIBUTING.md is too long and not read | Low    | Keep it concise; link to detailed docs.                                                  |
| AGENTS.md conflicts with CONTRIBUTING.md | Low    | Keep AGENTS.md focused on agent behavior and CONTRIBUTING.md on human contributors.      |
| GitHub templates are too heavy           | Low    | Keep templates minimal.                                                                  |

---

## Open Questions

1. **Should CONTRIBUTING.md be separate from AGENTS.md?** Yes. AGENTS.md is for agent instructions; CONTRIBUTING.md is for human contributors. Some overlap is okay, but keep the focus distinct.
2. **Should we add a Code of Conduct?** Not necessary for a small personal project; add if it grows.
3. **Should we auto-generate API docs from code?** Already done via `scripts/docs.sh` and `docs/API.md`. Keep that documented.
4. **Should the PR template require screenshots for UI changes?** Yes, but keep it lightweight.

---

## Alternatives Considered

- **Single monolithic docs file:** Rejected because separate files are easier to maintain and cross-reference.
- **Wiki instead of repo docs:** Rejected because repo docs stay in sync with code and are reviewable in PRs.
- **Automated contributor onboarding bot:** Not needed for the current team size.

---

## Implementation Notes for a Future Session

1. Draft `CONTRIBUTING.md` based on the existing docs and scripts.
2. Review and update `AGENTS.md`.
3. Add GitHub templates.
4. Cross-link everything from `README.md`.
5. Open a PR with only documentation changes.

After this phase, the project is well-documented for new contributors and agents.
