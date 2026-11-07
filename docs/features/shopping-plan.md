# Shopping Plan

The shopping-plan feature generates AI-powered shopping lists organised by store, helping users plan their next grocery trips based on what's running out or expiring.

## What it changes

- **AI list** — generates a multi-store shopping plan with itemised prices and reasoning
- **Regenerate** — replaces the current plan with a fresh AI-generated one
- **Check-off** — interactive checklist to track what's been bought
- **Grand total** — per-store and overall cost estimate
- **Not-configured state** — without a usable `reasoning` capability the page asks the household to set AI up (402 from the route)

## How the AI plan is produced

`POST /api/plans/generate` resolves the household's **reasoning** capability through the AI door
(ahaqqu/RumaQ#523 P4), asks for a JSON plan grounded in low stock, expiring items, recent purchases
and the household's stores, validates the answer against `planGenerateResponseSchema`, and then
grounds each price against the observed price catalog. Usage is recorded per call and never capped.

## How it works

1. The Plan page checks `ai_status.reasoning`; without it the page shows a prompt to set AI up
2. On initial render, a mock plan (`PLAN` from `data/mock.js`) is displayed for demo purposes
3. Tapping **Regenerate** triggers a simulated 1.3s AI call, replacing the plan
4. Each trip is grouped by store with items, quantities, and price estimates
5. Users check items off as they shop; when all items are checked, an "all bought" banner appears
6. The **Ask Assistant** button opens the assistant panel for custom requests

## API endpoints

| Method | Path                  | Auth | Description                              |
| ------ | --------------------- | ---- | ---------------------------------------- |
| POST   | `/api/plans/generate` | Yes  | Generate a plan with the reasoning model |
| POST   | `/api/plans`          | Yes  | Save a generated plan as active          |
| GET    | `/api/plans`          | Yes  | The active plan with its items           |

## Source

- `frontend/src/pages/Plan.jsx` — plan page with regenerate, checklist, trip grouping
- `frontend/src/data/mock.js` — `PLAN` mock data and helpers
- `frontend/src/components/Assistant.jsx` — assistant panel with proposal generation
