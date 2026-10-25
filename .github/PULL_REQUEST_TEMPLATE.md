<!-- Title: conventional commit style, e.g. "feat(frontend): ..." -->

## What changed & why

<!-- One or two paragraphs. Link the plan doc / issue, e.g. docs/plan/phase-NN-*.md -->

## How to test

<!-- Exact commands a reviewer can run: ./scripts/test.sh unit backend, manual steps, preview URL paths -->

## Checklist

- [ ] `./scripts/test.sh unit` passes (add/adjust tests for behavior changes)
- [ ] `./scripts/style.sh --check` passes
- [ ] New/changed API routes: `./scripts/docs.sh` run, `docs/API.md` committed
- [ ] New API endpoint has an automation scenario in `automation/tests/local/api/`; new UI flow in `automation/tests/local/e2e/`
- [ ] Docs updated if behavior/architecture changed
- [ ] No secrets or `.env` contents committed

## Screenshots (if UI changed)

<!-- Before/after, desktop + mobile if layout-relevant -->
