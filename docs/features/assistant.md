# Assistant

The assistant is a floating action button (FAB) that opens a slide-out panel for AI-powered household management tasks — planning trips, finding deals, and reducing waste.

## What it changes

- **FAB** — persistent button in the bottom-right corner, labelled with a sparkle icon
- **Dialog panel** — slide-out panel with greeting, status, and action buttons
- **Quick actions** — "Plan this week", "Cheapest store", "Use up expiring" — each triggers an AI analysis
- **Proposal** — AI returns a structured shopping proposal with trips, items, and cost estimate
- **Apply to plan** — accepted proposals navigate the user to the Plan page
- **No-key fallback** — without an AI key, the panel shows a prompt to configure one
- **Usage indicator** — shows today's call count for the acting member; usage is
  recorded, never capped (the daily limit was removed in #353)

## How it works

1. The FAB is always visible; tapping it opens the assistant panel
2. On open, connectivity is the household's `ai_status.reasoning` (chat is a reasoning call, #523 P4); usage is shown when loaded
3. Without a usable reasoning capability, the panel shows a button that navigates to Settings
4. With one, the panel shows a persona-personalised greeting and three quick actions
5. Tapping a quick action triggers a simulated AI call (1.1s); a loading spinner is shown
6. The response is a mock proposal with store groupings, item lists, and a total estimate
7. **Apply to Plan** closes the panel and navigates to the Plan page
8. **Change** dismisses the proposal and returns to the action list

## Source

- `frontend/src/components/Assistant.jsx` — FAB, panel, actions, proposal
- `frontend/src/components/AppShell.jsx` — mounts `Assistant` and wires `aiKey`/`assistantOpen` state
- `frontend/src/data/mock.js` — `AI_USAGE`, `usageState` helpers
- `frontend/src/lib/persona.js` — assistant greeting/question text
