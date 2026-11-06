// Frontend plugin catalog manifest type (ahaqqu/RumaQ#435 — plugin
// architecture phase A, docs/plan/plugin-architecture.md §4.3/§4.5). TYPE
// ONLY in this ticket: the catalog registry, the nav filter at AppShell's
// three render sites, and the route gates are ticket 2; the settings panels
// are ticket 3. The backend carries its own manifest type
// (backend/src/plugins/types.ts) — the bundles share no module graph, so
// this type cannot import it and must not try: the contract between the two
// sides is plugin IDS only (the /api/me enabledPlugins list), never objects.

// The nav group a plugin's entry renders into — mirrors the AppShell groups
// (NAV / HOUSEHOLD_NAV / ADMIN_NAV, AppShell.jsx). 'main' is the header nav;
// the household group is where the documents entry lives today.
export type PluginNavGroup = 'main' | 'household' | 'admin'

// A React function component, modeled structurally: the repo's frontend is
// JSX-first and carries no @types/react, so the catalog type does not import
// React — the shell renders these, which is all the type needs to promise.
export type PluginComponent = (props: Record<string, unknown>) => unknown

/**
 * One plugin's declared UI contributions (§4.5): core composes them — a
 * plugin never edits AppShell.jsx. Static typed objects, validated by a
 * parity test against the server manifests (ticket 2: every server id has a
 * catalog entry and vice versa; every catalog route lives under the server's
 * prefix).
 */
export type PluginCatalogEntry = {
  /** Stable slug — MUST equal the server manifest id. */
  id: string
  /** i18n key for the display label (en + id locales are mandatory). */
  labelKey: string
  /** i18n key for the settings catalog's one-line description (T3); en + id
   * mandatory — registry.test.js resolves it against BOTH locales. */
  descriptionKey: string
  /** The route path this plugin owns, e.g. '/documents'. Never moves. */
  routePath: string
  /** Which nav group the entry renders into. */
  navGroup: PluginNavGroup
  /** Icon from the shared icon exports (components/icons.jsx). */
  icon: PluginComponent
  /** Owner-facing capability ids (snake_case) for the settings catalog (T3). */
  capabilities: readonly string[]
  /** The settings panel component (ticket 3); optional until then. */
  settingsPanel?: PluginComponent
}
