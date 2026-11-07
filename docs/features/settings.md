# Settings

The settings page manages the household's AI providers and capabilities, persona
personalisation, storage locations, recorded stores, and display preferences.

## What it changes

- **AI providers** — up to ten providers the household owns: label, wire
  protocol (`openai-compatible`, `anthropic`, `gemini`, `questions`), an optional
  vendor preset, a base URL, an optional default model, and the API key. The key
  is write-only: the list says "key saved", never the value.
- **AI capabilities** — assign one provider to each fixed job: Decision
  (structured choices: review verdicts, classification, JSON answers), Reasoning
  (chat and shopping plans), Vision (receipts and documents). Each row takes an
  optional model (blank inherits the provider's default) and, for Decision and
  Reasoning, a thinking level; Vision has no thinking knob.
- **Test connection** — probes the provider row's stored key and endpoint and
  reports an outcome, never the provider's error body.
- **Usage meter** — calls and tokens today plus the cache hit rate when the
  provider reports one; usage is recorded, never capped.
- **Persona** — define user role and AI role for personalised tone, with
  AI-generated copy
- **Locations** — manage storage locations (Kulkas, Freezer, etc.) used in inventory
- **Stores** — manage store names used in purchases and plans
- **Display** — motion preference (none/reduced/standard) and language (English/Indonesian)

## How it works

1. Preferences are fetched via `useSettings()` (`GET /api/settings`); the AI block
   is its own pair of reads, `useAiProviders()` and `useAiCapabilities()`.
2. The provider list is household-scoped: every member sees it, `can_manage`
   (the household role) decides whether the add/edit/delete/test controls exist,
   and a member sees "Managed by …" instead. A member never gets a control that
   would 403.
3. Nothing is preselected and there is no server default: a household with no
   provider sees the empty state, the capability rows do not exist yet, and every
   AI feature says to set AI up. A capability with no model anywhere is
   "not configured" (402 on its routes), not an error.
4. Writes go to `POST/PATCH/DELETE /api/ai/providers` and
   `PUT/DELETE /api/ai/capabilities/:capability`; the key is sealed server-side
   with the provider row's id as additional authenticated data and never leaves
   the server. Deleting a provider clears its assignments in the same batch and
   the confirmation names the capabilities that will become not configured.
5. Persona roles are saved via `PATCH /api/settings`; the persona's roles and
   colours apply immediately from the built-in copy. The AI rewrite of the app
   text is NOT called from the page in P3 — the provider/base-URL/model fields it
   read are gone with the columns, so it returns through the door in P5 (#523
   P5). Copy that still promised a browser-key rewrite is removed.
6. Locations and stores are CRUD-managed through their respective endpoints.
7. Language changes via i18n and persists to settings; motion preference controls
   CSS animation levels across the app.

## API endpoints

| Method | Path                               | Auth  | Description                                 |
| ------ | ---------------------------------- | ----- | ------------------------------------------- |
| GET    | `/api/settings`                    | Yes   | Fetch user settings + the AI status block   |
| PATCH  | `/api/settings`                    | Yes   | Update user settings (AI fields are a 400)  |
| GET    | `/api/ai/presets`                  | Yes   | The preset catalog (no models, no defaults) |
| GET    | `/api/ai/providers`                | Yes   | List household providers + `can_manage`     |
| POST   | `/api/ai/providers`                | Owner | Add a provider                              |
| PATCH  | `/api/ai/providers/:id`            | Owner | Edit a provider, re-key or clear            |
| DELETE | `/api/ai/providers/:id`            | Owner | Delete + report cleared capabilities        |
| POST   | `/api/ai/providers/:id/test`       | Owner | Probe the stored credentials                |
| GET    | `/api/ai/capabilities`             | Yes   | The three assignments + resolved status     |
| PUT    | `/api/ai/capabilities/:capability` | Owner | Assign (or re-assign) a capability          |
| DELETE | `/api/ai/capabilities/:capability` | Owner | Clear an assignment (idempotent)            |
| GET    | `/api/ai/usage`                    | Yes   | AI usage stats                              |
| GET    | `/api/locations`                   | Yes   | List storage locations                      |
| POST   | `/api/locations`                   | Yes   | Create a location                           |
| DELETE | `/api/locations/:id`               | Yes   | Delete a location                           |
| GET    | `/api/stores`                      | Yes   | List stores                                 |
| POST   | `/api/stores`                      | Yes   | Create a store                              |
| DELETE | `/api/stores/:id`                  | Yes   | Delete a store                              |

## Source

- `frontend/src/pages/Settings.jsx` — the preference surfaces (persona, locations, stores, display, account)
- `frontend/src/components/AiSettingsSection.jsx` — the AI providers + AI capabilities sections
- `frontend/src/lib/queries/ai-settings.js` — provider/capability/preset hooks
- `frontend/src/lib/aiStatus.js` — the one `ai_status` → "configured" predicate
- `frontend/src/lib/queries/settings.js` — `useSettings`, `useUpdateSettings`
- `frontend/src/lib/queries/locations.js` — location CRUD hooks
- `frontend/src/lib/queries/stores.js` — store CRUD hooks
- `frontend/src/lib/queries/usage.js` — `useUsage` hook
- `frontend/src/lib/persona.js` — persona engine
- `backend/src/apps/api.ts` — settings and the AI settings routes
- `backend/src/lib/ai/provider-settings.ts` — provider/capability writes and the probe
- `backend/migrations/0041_ai_gateway.sql`, `0042_drop_legacy_ai_settings.sql` — the tables and the column drop
