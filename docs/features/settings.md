# Settings

The settings page manages AI provider configuration, persona personalisation, storage locations, recorded stores, and display preferences.

## What it changes

- **AI key** — set or change an API key for one of six providers (OpenCode, OpenAI, Anthropic, Gemini, Ollama Cloud, Custom OpenAI-compatible)
- **Provider selector** — choose which AI backend to use; the Custom option additionally takes a Base URL and model name for any OpenAI-compatible endpoint
- **Test connection** — validate the API key before saving
- **Usage meter** — shows current AI usage against daily limits
- **Persona** — define user role and AI role for personalised tone, with AI-generated copy
- **Locations** — manage storage locations (Kulkas, Freezer, etc.) used in inventory
- **Stores** — manage store names used in purchases and plans
- **Display** — motion preference (none/reduced/standard) and language (English/Indonesian)

## How it works

1. Settings are fetched via `useSettings()` on mount (`GET /api/settings`)
2. AI key is stored as a password field; `has_ai_key` boolean indicates whether one is set (the actual key is never returned)
3. Test calls `testAiKey(provider, key)` which sends a minimal prompt to the selected provider
4. Persona roles are saved via `PATCH /api/settings`; if AI key is present, `regenerateCopy()` rewrites all app copy
5. Locations and stores are CRUD-managed through their respective endpoints
6. Language changes via i18n and persists to settings
7. Motion preference controls CSS animation levels across the app

## API endpoints

| Method | Path                 | Auth | Description            |
| ------ | -------------------- | ---- | ---------------------- |
| GET    | `/api/settings`      | Yes  | Fetch user settings    |
| PATCH  | `/api/settings`      | Yes  | Update user settings   |
| GET    | `/api/ai/usage`      | Yes  | AI usage stats         |
| GET    | `/api/locations`     | Yes  | List storage locations |
| POST   | `/api/locations`     | Yes  | Create a location      |
| DELETE | `/api/locations/:id` | Yes  | Delete a location      |
| GET    | `/api/stores`        | Yes  | List stores            |
| POST   | `/api/stores`        | Yes  | Create a store         |
| DELETE | `/api/stores/:id`    | Yes  | Delete a store         |

## Source

- `frontend/src/pages/Settings.jsx` — full settings UI
- `frontend/src/lib/api.js` — `testAiKey`
- `frontend/src/lib/queries/settings.js` — `useSettings`, `useUpdateSettings`
- `frontend/src/lib/queries/locations.js` — location CRUD hooks
- `frontend/src/lib/queries/stores.js` — store CRUD hooks
- `frontend/src/lib/queries/usage.js` — `useUsage` hook
- `frontend/src/lib/persona.js` — persona engine
- `backend/src/apps/api.ts` — settings, locations, stores endpoints
