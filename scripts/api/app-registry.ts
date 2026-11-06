// The single source of truth for which backend apps make up the API contract.
//
// Both generators — scripts/api/generate-openapi-spec.ts (the typed client's
// openapi.json) and scripts/docs/generate-api-docs.ts (docs/API.md) — iterate
// THIS list, so registering a new domain app is one edit in one file and the
// two outputs can never disagree about which apps exist. Per-app options and
// path remapping stay script-local: the docs generator carries the
// cookieAuth security scheme, and the auth app's prefix-less routes are
// remapped by each consumer (the gateway adds /api/auth at mount time).
//
// Order matters only for output stability (paths merge in this order); the
// auth app must stay LAST so the openapi generator's remapped auth paths
// keep their place after the domain apps.

import { apiApp } from '../../backend/src/apps/api.js'
import { householdsApp } from '../../backend/src/apps/households.js'
import { createDocumentsPlugin } from '../../backend/src/plugins/documents/app.js'
import { tasksApp } from '../../backend/src/apps/tasks.js'
import { calendarApp } from '../../backend/src/apps/calendar.js'
import { pluginsApp } from '../../backend/src/apps/plugins.js'
import { authApp } from '../../backend/src/apps/auth.js'

// The documents plugin is a factory since ticket 4 (#438) — the registry
// injects ports.storage from the DOCUMENTS binding. The docs pipeline only
// reads describeRoute metadata (handlers never run), so a no-op adapter
// satisfies the port here; script-local, like the auth path remap below.
const documentsApp = createDocumentsPlugin({
  ports: {
    storage: {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
    },
  },
}).app

export const API_APPS: { name: string; app: typeof apiApp }[] = [
  { name: 'api', app: apiApp },
  { name: 'households', app: householdsApp },
  { name: 'documents', app: documentsApp },
  { name: 'tasks', app: tasksApp },
  { name: 'calendar', app: calendarApp },
  { name: 'plugins', app: pluginsApp },
  { name: 'auth', app: authApp },
]
