# Phase 09 — Quality Assurance & Accessibility

**Status:** Done (page-level E2E features for inventory/plan/history/settings/receipt + axe-core accessibility scans implemented as `automation/tests/local/e2e/features/*.feature` with per-scenario DB reset; first-wave a11y fixes shipped: text-contrast tokens, unnamed Settings submit buttons, assistant FAB accessible name; performance budget enforced via `scripts/ci/bundle-budget.mjs` (250 KB JS gzip) and Lighthouse CI in `ci.yml`; login/logout flows remain covered by `smoke.feature` instead of a separate login feature. Remaining out-of-wave items: `--ok` token contrast (~3.8:1, unrendered on audited pages), manual screen-reader pass, Lighthouse runs on the live preview URL)  
**Priority:** P1/P2  
**Source sections:** Section 8 of `docs/PROJECT_PLAN.md`  
**Estimated effort:** Medium

---

## Objective

Raise confidence in the product through better test coverage, accessibility compliance, and performance guardrails. Ensure the app is usable with a keyboard, screen reader, and assistive technologies, and that it stays within a reasonable bundle size and initial load budget. The user impact is: _the app is reliable, inclusive, and fast_.

This phase is P1/P2 and should not block the MVP, but accessibility should be addressed early because it is harder to retrofit.

---

## Acceptance Criteria

1. End-to-end tests cover the main user flows: login, add receipt, update stock, generate plan, view history, update settings.
2. Accessibility audit passes for keyboard navigation, focus management, color contrast, ARIA labels, and form labels.
3. A performance budget is defined and enforced in CI (bundle size, First Contentful Paint, Largest Contentful Paint).
4. Lighthouse CI or similar runs in CI and reports scores.
5. All interactive elements are reachable and operable via keyboard.
6. No critical or serious axe-core violations.
7. Unit and integration tests remain passing and coverage thresholds are met.
8. `vp test` and `vp check --no-fmt --no-lint` pass.

---

## Dependencies

- Phases 01-05 for the features to be tested.
- Existing Playwright setup in `automation/tests/local/e2e/`.
- Existing Vitest setup for unit and integration tests.
- Existing CI workflows in `.github/workflows/`.

---

## Scope

### 1. Expand E2E tests

- Add BDD feature files in `automation/tests/local/e2e/`:
  - `login.feature` — log in via email auth or Google OAuth (email auth is easier for tests).
  - `add-receipt.feature` — navigate to Add, mock a scan, confirm purchase, verify stock.
  - `inventory.feature` — update stock quantity, search, filter by location.
  - `plan.feature` — generate plan, mark item bought, verify stock updated.
  - `history.feature` — view purchase history, verify month totals.
  - `settings.feature` — update AI key, add/remove location and store.
- Add step definitions for each feature using the existing Playwright BDD setup.
- Use the existing Docker test harness or run locally.
- Ensure tests are stable and not flaky (avoid hard waits, use proper selectors, wait for network idle).
- Use `data-testid` attributes where semantic selectors are not enough.

### 2. Accessibility audit

- Run axe-core in Playwright tests or as a separate CI job.
- Checklist:
  - All buttons, links, and form inputs have accessible labels.
  - Focus is visible and follows a logical order.
  - Color contrast is at least 4.5:1 for text and 3:1 for UI components.
  - Images have alt text (receipt thumbnails have meaningful alt text).
  - ARIA live regions announce loading and error states.
  - Modal dialogs trap focus and return focus on close.
  - The app is usable with `prefers-reduced-motion`.
- Fix violations found by axe-core.
- Add an accessibility test that runs axe on each page.

### 3. Performance budget

- Define budgets in `frontend/package.json` or a config file:
  - JavaScript bundle initial size < 250 KB gzipped.
  - Total image size on initial load < 500 KB.
  - First Contentful Paint < 1.8 s on simulated mobile.
- Use Lighthouse CI to run on the production or preview URL.
- Add a CI job that fails if Lighthouse scores drop below thresholds (e.g., Performance >= 70, Accessibility >= 90).
- Add bundle analysis (`vite-bundle-visualizer` or `@rollup/plugin-visualizer`) to identify large dependencies.

### 4. Test automation improvements

- Ensure `docker compose -f automation/docker-compose.yml` runs all tests cleanly.
- Add coverage reporting for integration tests if not already present.
- Add a test report artifact in CI.
- Keep test fixtures (`automation/tests/fixtures/seed.sql`, `reset.sql`) up to date with schema changes.

### 5. Documentation

- Update `docs/TEST_STRATEGY.md` with E2E coverage, accessibility checks, and performance budget.
- Document how to run E2E tests locally and how to debug failures.
- Add a checklist for new features: unit tests, integration tests, E2E test if user-facing, accessibility check.

---

## Out of Scope

- Full manual QA regression on every device.
- Visual regression testing (can be added later with Playwright screenshots).
- Load testing (out of scope for MVP on Cloudflare free tier).
- Internationalization audit beyond existing i18n setup.
- Third-party security audit (Phase 06 covers internal hardening).

---

## Database Changes

No schema changes. This phase is about testing and auditing.

---

## Testing Strategy

### E2E tests

1. Add feature files and step definitions as listed above.
2. Use Page Object Model or helper functions to keep step definitions clean.
3. Run E2E tests in CI using the existing `test-automation.yml` workflow.

### Accessibility tests

1. Add `axe-core` to Playwright tests.
2. Create an `accessibility.spec.js` that visits each page and runs axe.
3. Fix violations and re-run.

### Performance tests

1. Add Lighthouse CI to `.github/workflows/ci.yml` or a new `lighthouse.yml`.
2. Define budget thresholds.
3. Add bundle analysis to the build step.

### Manual verification

1. Navigate the app using only the keyboard.
2. Test with a screen reader (NVDA on Windows, VoiceOver on macOS).
3. Check color contrast with a browser extension.
4. Run Lighthouse in Chrome DevTools on the production URL.

---

## Deployment & Secrets

- No new secrets for testing, but Lighthouse CI may require a token if using the official Lighthouse CI server. For GitHub Actions, use the free Lighthouse CI action or run Lighthouse directly.
- E2E tests may need a test user account; use email auth in tests with test credentials from `backend/migrations/0002_email_auth.sql`.

---

## Risks & Mitigations

| Risk                                                   | Impact | Mitigation                                                                   |
| ------------------------------------------------------ | ------ | ---------------------------------------------------------------------------- |
| E2E tests are flaky and slow CI                        | Medium | Use stable selectors, retry flaky tests, run in parallel where possible.     |
| Accessibility issues require UI redesign               | Medium | Address accessibility early; most issues are small fixes (labels, contrast). |
| Performance budget fails because of a large dependency | Medium | Use bundle analysis to identify and split/lazy-load large dependencies.      |
| Lighthouse CI scores vary between runs                 | Medium | Run multiple times and take median; use thresholds as warnings first.        |
| Coverage thresholds are too strict                     | Low    | Keep thresholds reasonable and only raise them as coverage improves.         |

---

## Open Questions

1. **Should accessibility tests be required to pass in CI?** Recommendation: yes, but start with no critical/serious violations and allow warnings.
2. **Should performance budgets be warnings or hard failures?** Recommendation: warnings initially; hard failures once the budget is stable.
3. **Should E2E tests run on every PR or only on main?** Recommendation: every PR, but keep the test suite lean to avoid long CI times.
4. **Should visual regression testing be added?** Recommendation: not in this phase; add later if design churn decreases.
5. **Should the bundle size budget include third-party fonts?** Recommendation: yes, but measure separately (JS, CSS, images, fonts).
6. **Should we test accessibility with real screen readers or just axe-core?** Recommendation: axe-core in CI; periodic manual screen reader testing.

---

## Alternatives Considered

- **Manual QA only:** Rejected because automated tests catch regressions faster and are cheaper long-term.
- **Cypress instead of Playwright:** Rejected because Playwright is already in use and supports multiple browsers.
- **Storybook + Chromatic for visual regression:** Rejected for MVP; consider later.
- **Separate accessibility service:** Not needed; axe-core and Lighthouse are sufficient for this stage.

---

## Implementation Notes for a Future Session

1. Start with the E2E test gaps (login, add receipt, plan, history).
2. Add axe-core to the existing Playwright setup.
3. Fix the first wave of accessibility issues.
4. Define and document the performance budget.
5. Add Lighthouse CI or bundle analysis to CI.
6. Update `docs/TEST_STRATEGY.md`.
7. Run the full test suite and open a PR.

After this phase, the app has strong automated quality gates and is measurably accessible and performant.
