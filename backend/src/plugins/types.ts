// Plugin core types (ahaqqu/RumaQ#435 — plugin architecture phase A,
// docs/plan/plugin-architecture.md §2, §4.2, §4.3). One canonical manifest
// type for the server bundle. The frontend carries its own catalog manifest
// type (frontend/src/plugins/types.ts) because the two bundles share no
// module graph — the contract between them is plugin IDS only (/api/me's
// enabledPlugins), never objects, never React.
import type { Hono } from 'hono'
import type { Env } from '../types.js'
import type { StorageAdapter } from '../ports/storage/index.js'

/**
 * Port ids the registry knows how to wire (§4.2 — ports are few and earn
 * their existence; StorageAdapter is port #1). A manifest `ports` entry must
 * be one of these, and the wiring site satisfies the contract with
 * `satisfies` — TS structural typing is the version check; there is no
 * stringly-typed version ledger (rev 2, §4.2).
 */
export const KNOWN_PORT_IDS = ['storage'] as const
export type PortId = (typeof KNOWN_PORT_IDS)[number]

/**
 * Cron tasks are declared with their scope NOW (§4.3) so the field does not
 * need a breaking change when the first task lands (ticket 7). No plugin in
 * phase A declares one — the vault has none.
 */
export type PluginCronTask = {
  /** 'global' ignores enablement; 'household' iterates the enabled set. */
  scope: 'global' | 'household'
}

/**
 * The server manifest — a static typed object (never JSON, never scanned
 * from disk; validation is a unit test + CI step, §1.1 adopt-4, the Grafana
 * startup-scan pattern moved to build time because Workers have no startup
 * scan worth failing at). Every field required.
 */
export type PluginManifest = {
  /** Stable slug; also household_plugins.plugin_id and the i18n namespace. */
  id: string
  /** Human label (EN); customer-facing copy stays in i18n (tickets 2–3). */
  name: string
  /** The plugin's own semver, bumped when its surface changes. */
  version: string
  /** The full API prefix the plugin owns, e.g. '/api/documents'. */
  routePrefix: string
  /** The resolution default when household_plugins has no row (§4.3). */
  defaultEnabled: boolean
  /** Declared capabilities (snake_case) — surfaced by the catalog, ticket 3. */
  capabilities: readonly string[]
  /** Ports the plugin needs; each must be a KNOWN_PORT_IDS member. */
  ports: readonly PortId[]
  /**
   * Tables the plugin owns, declared and tested disjoint across plugins
   * (§4.1 — deliberately NOT inferred from a prefix: the vault's
   * document_audit does not share the documents_ prefix, and that is fine
   * once the list is explicit).
   */
  ownedTables: readonly string[]
  /** Deferred scheduling handoff (ticket 7). */
  cronTasks?: readonly PluginCronTask[]
}

/**
 * The ports a plugin receives instead of constructing adapters inline (§4.1
 * forbidden-4). Injected by the registry at factory time (registry.ts); the
 * documents plugin guards its required port at construction (app.ts), so a
 * missing wiring fails fast, never mid-request.
 */
export type PluginPorts = {
  /** Document/object bytes — adapter #1 (ports/storage, private R2). */
  storage?: StorageAdapter
}

/** What the registry hands a plugin factory. */
export type PluginDeps = { ports: PluginPorts }

/**
 * One purge-chunk outcome (§3.4 — "purge is a job, not a request"): what the
 * chunk spent and whether the household's purge has nothing left to do.
 * `objects` feeds the core driver's per-invocation subrequest budget (50 on
 * the Workers free plan — each storage delete IS one subrequest); `drained`
 * tells the driver it may write the completion receipt / dissolve.
 */
export type PluginPurgeChunk = {
  /** Storage objects deleted by this chunk (the subrequest spend). */
  objects: number
  /** True when the plugin has no rows left to purge for this household. */
  drained: boolean
}

/**
 * The per-plugin purge job (ticket 5, §3.4): one CHUNK of one household's
 * purge, bytes-before-rows, idempotent per document — callable as many times
 * as the drain needs, resuming from the row's cursor. The plugin owns the
 * HOW (its index, its port); the core driver (lib/plugin-purge.ts) owns the
 * WHEN (the nightly cron tick) and the budget. Initiation (the typed
 * confirmation, the pending state) is core's; the job only ever drains.
 */
export type PluginPurgeJob = (args: {
  db: D1Database
  householdId: string
  /** Max storage objects this chunk may delete — the subrequest budget. */
  maxObjects: number
}) => Promise<PluginPurgeChunk>

/**
 * One plugin's contribution: its manifest + the mounted Hono app. "Route
 * mounts + metadata" — exactly what the factory returns. `purge` rides the
 * registration when the manifest declares the 'purge' capability: the core
 * cron tick and the household-dissolution drain call it through this seam,
 * never through plugin internals (T7 will generalize plugin-declared
 * scheduled tasks on top of the same seam — this is deliberately the only
 * job-shaped hook until then). `purgeBudgetFloor` is the job's per-chunk
 * minimum (the documents plugin: DOCUMENT_MAX_FILES — a chunk deletes whole
 * documents only, and one document may hold that many files): the driver
 * treats a remaining budget below the floor as EXHAUSTED instead of handing
 * out a sub-floor chunk the job would have to refuse (P1-A2, PR #474
 * review — a 15-file vault left a 1–19 remainder that threw and starved
 * every household behind it). Required alongside `purge`.
 */
export type PluginRegistration = {
  manifest: PluginManifest
  app: Hono<Env>
  purge?: PluginPurgeJob
  purgeBudgetFloor?: number
}

/**
 * The plugin factory contract (§4.3): a plugin exports
 * createXPlugin(deps: PluginDeps) returning its registration. The factory is
 * the one place an adapter is injected, so "cannot register a route without
 * auth" is structural and no plugin reads a binding except env.DB. The
 * documents plugin is the first implementation (plugins/documents/app.ts —
 * ticket 4 #438 removed its five inline createR2StorageAdapter call sites
 * through this seam).
 */
export type PluginFactory = (deps: PluginDeps) => PluginRegistration
