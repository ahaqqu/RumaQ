# RumaQ — Testing Strategy

## Unit test

| Location                          | Runner | Environment | Coverage                                                                           |
| --------------------------------- | ------ | ----------- | ---------------------------------------------------------------------------------- |
| `frontend/src/**/*.test.{js,jsx}` | Vitest | jsdom       | 50/50/50/50                                                                        |
| `backend/src/**/*.test.ts`        | Vitest | Node        | 50/50/50/50 (D1 mocked)                                                            |
| `scraper/{src,test}/**/*.test.ts` | Vitest | Node        | no threshold yet (new workspace; all IO injected, haqita fixtures ported verbatim) |

```
./scripts/test.sh unit
```

## Local automation test

All services behind `nginx` proxy at `localhost:3000`. Worker exposes `TEST_MODE`-guarded admin endpoints. Gherkin features + `jest-cucumber` for API, `playwright-bdd` for E2E. Run by Vitest + Playwright inside Docker.

```
./scripts/test.sh automation-local
```

## Live production automation test

Runs every 6 hours via `.github/workflows/smoke.yml`. Base URL: `rumaq.ahaqqu.com` (app + API, same origin; the Worker Custom Domain). Run by Cucumber-js (API health) and Playwright (E2E login/logout). On failure → auto-creates issue with `smoke-failure` label.

```
./scripts/test.sh automation-live
```

## Acceptance criteria

- [ ] Frontend unit test coverage thresholds met (50/50/50/50) — `./scripts/test.sh unit frontend --coverage`
- [ ] Backend unit test coverage thresholds met (50/50/50/50) — `./scripts/test.sh unit backend --coverage`
- [ ] Scraper unit tests pass — `./scripts/test.sh unit scraper`
- [ ] New API endpoint has automation test scenario — `automation/tests/local/api/`
- [ ] New UI flow has automation test scenario — `automation/tests/local/e2e/`
- [ ] Local automation tests pass — `./scripts/test.sh automation-local`
- [ ] API docs match current routes — `./scripts/docs.sh` + `git diff --exit-code docs/API.md`
- [ ] All unit tests pass — `./scripts/test.sh unit`
- [ ] Code style and lint pass — `./scripts/style.sh --check`
