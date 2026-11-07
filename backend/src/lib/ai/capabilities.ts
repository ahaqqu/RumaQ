// Capability resolution — the household-scoped ladder (ahaqqu/RumaQ#523,
// plan §5.1). This module owns the ai_providers / ai_capabilities reads: the
// resolver, and the settings read model the API serializes.
//
// The ladder is TWO outcomes, by owner decision (D8): an assignment that
// resolves to a usable provider, or null. There is no server branch, no env
// key, no platform default. An unconfigured capability is unconfigured; the
// door maps null to `AiError('not_configured')` (402).
//
// The household is the lookup key, not the user: two members of the same
// household resolve the SAME row (and therefore the same key), which is what
// D1 asks for. The acting user id never enters these queries.
//
// KEY MATERIAL IS MODULE-PRIVATE (plan §2.2): `resolveAccess` returns
// `{capability, call}` only, and the decrypted key + endpoint + thinking level
// live in `key-material.ts` — a door-internal module the boundary test forbids
// ANY outside import. No route, feature, or response can reach a key; a handle
// this module did not issue carries no material, so every call fails closed.

import type { Env } from '../../types.js'
import {
  CAPABILITIES,
  THINKING_LEVELS,
  type AiAccessHandle,
  type AiCall,
  type AiCtx,
  type Capability,
  type ProviderKind,
  type ThinkingLevel,
} from './types.js'
import { presetEndpoint } from './presets.js'
import { decryptProviderKey } from './credentials.js'
import { holdMaterial } from './key-material.js'

type AccessRow = {
  capability: Capability
  model: string | null
  thinking_level: string | null
  provider_id: string
  kind: ProviderKind
  preset: string | null
  base_url: string | null
  default_model: string | null
  encrypted_key: string | null
}

// One subrequest, one join (plan §5.1). The PK (household_id, capability) makes
// this a single-row seek; provider_id is indexed on the provider side. The join
// carries the household too: the assignment's own scope is not enough, because
// a provider_id from another household must resolve nothing at all rather than
// put that household's decrypted key behind this household's request (thermos
// A1). SQLite has no composite FK to enforce it, so the query does.
const ACCESS_SQL = `SELECT c.capability AS capability,
        c.model AS model,
        c.thinking_level AS thinking_level,
        p.id AS provider_id,
        p.kind AS kind,
        p.preset AS preset,
        p.base_url AS base_url,
        p.default_model AS default_model,
        p.encrypted_key AS encrypted_key
   FROM ai_capabilities c
   JOIN ai_providers p ON p.id = c.provider_id AND p.household_id = c.household_id
  WHERE c.household_id = ? AND c.capability = ?`

function normalizeModel(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeThinkingLevel(value: string | null): ThinkingLevel | null {
  return value && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : null
}

/**
 * The endpoint a row resolves to: its own base URL wins over the preset's.
 * Exported for the settings writes (provider-settings.ts), which must answer
 * "can this row serve a call" with THIS rule and not a second copy of it
 * (#523 P3 review A4 — the P2 review B1 lesson, applied to the endpoint).
 */
export function resolvedEndpoint(
  row: Pick<AccessRow, 'base_url' | 'preset' | 'kind'>
): string | null {
  return row.base_url ?? presetEndpoint(row.preset, row.kind)
}

/**
 * Can this row serve a call at all? A missing key is handled by the caller; a
 * missing endpoint is only fatal for kinds that have no canonical one. The
 * endpoint comes from the row, its preset's catalog row, or a wire that owns
 * one — `resolvedEndpoint` is the resolver's own rule, so a `questions` row
 * with a preset endpoint (openrouter-decisions, §9) is as usable as an
 * `openai-compatible` one.
 */
export function endpointResolvable(row: Pick<AccessRow, 'base_url' | 'preset' | 'kind'>): boolean {
  // anthropic / gemini adapters own their canonical endpoint; anything else is
  // not a wire this gateway speaks (the CHECK makes that unreachable in D1).
  if (row.kind === 'anthropic' || row.kind === 'gemini') return true
  return resolvedEndpoint(row) != null
}

/**
 * The ONE model rule (owner decision, #523): `capability.model ??
 * provider.default_model ?? not configured`. The resolver and the settings
 * status read call this same function, so the payload can never claim a
 * capability the resolver would refuse (the P1 A1 "two queries disagree" class).
 */
function effectiveModel(row: Pick<AccessRow, 'model' | 'default_model'>): string | null {
  return normalizeModel(row.model) ?? normalizeModel(row.default_model)
}

/**
 * Is this row actually usable by the resolver? Key + endpoint + model, the
 * three conditions `toAccessHandle` refuses on. `loadHouseholdAiConfig` asks
 * the same question so `ai_status` and `resolveAccess` cannot drift.
 */
function rowUsable(
  row: Pick<AccessRow, 'encrypted_key' | 'base_url' | 'preset' | 'kind' | 'model' | 'default_model'>
): boolean {
  if (!row.encrypted_key) return false
  if (!endpointResolvable(row)) return false
  return effectiveModel(row) != null
}

async function toAccessHandle(ctx: AiCtx, row: AccessRow): Promise<AiAccessHandle | null> {
  const where = `household=${ctx.householdId} capability=${row.capability}`
  if (!endpointResolvable(row)) {
    console.warn(`[ai] capability assignment has no usable endpoint ${where}`)
    return null
  }
  // capability.model ?? provider.default_model ?? not configured (owner
  // decision, #523). There is deliberately NO adapter default behind this: a
  // row with no model anywhere is not configured, not "the vendor's usual".
  const model = effectiveModel(row)
  if (model == null) {
    console.warn(
      `[ai] capability assignment has no model ${where} (set one on the capability or the provider)`
    )
    return null
  }
  let apiKey: string | null
  try {
    apiKey = await decryptProviderKey(ctx.env, {
      id: row.provider_id,
      encrypted_key: row.encrypted_key,
    })
  } catch (err) {
    // A broken stored key is NOT a 500 (plan §5.1): log without key material,
    // treat the row as unusable, let Settings say "needs setup".
    console.warn(
      `[ai] stored provider unusable ${where}: ${err instanceof Error ? err.message : 'decrypt failed'}`
    )
    return null
  }
  if (!apiKey) {
    console.warn(`[ai] capability assignment has no usable provider ${where}`)
    return null
  }

  const call: AiCall = {
    capability: row.capability,
    householdId: ctx.householdId,
    providerKind: row.kind,
    providerId: row.provider_id,
    model,
    // D9: every handle v1 can return is household-funded. The day a platform
    // provider exists, this is the ONLY place that decides it, and the meter in
    // the facade is the only place a limit is applied (plan §2.6). No env
    // fallback, no second funding branch (D8).
    funding: 'household',
  }
  const handle: AiAccessHandle = { capability: row.capability, call }
  holdMaterial(handle, {
    apiKey,
    baseUrl: resolvedEndpoint(row),
    preset: row.preset,
    thinkingLevel: normalizeThinkingLevel(row.thinking_level),
  })
  return handle
}

/**
 * Resolve one capability for the household the request acts in.
 *
 * Two outcomes only:
 *   - the household's assignment points at a keyed, resolvable provider →
 *     a handle (key material stays in this module);
 *   - anything else (no assignment, no key, unusable endpoint, undecryptable
 *     ciphertext) → null, which the door maps to the normal 402.
 *
 * Never throws, never 500s on a stored-key problem.
 */
export async function resolveAccess(
  ctx: AiCtx,
  capability: Capability
): Promise<AiAccessHandle | null> {
  const row = await ctx.env.DB.prepare(ACCESS_SQL)
    .bind(ctx.householdId, capability)
    .first<AccessRow>()
  if (!row) return null
  return toAccessHandle(ctx, row)
}

// --- settings read model ----------------------------------------------------

export type HouseholdProvider = {
  id: string
  label: string
  kind: ProviderKind
  base_url: string | null
  /** The provider-level default model (NULL = none typed). */
  default_model: string | null
  has_key: boolean
  created_at: string
  updated_at: string
}

export type HouseholdCapabilityAssignment = {
  /** Null when the capability is not assigned — there is no implicit assignment. */
  provider_id: string | null
  provider_label: string | null
  /**
   * The assignment's OWN model column, not the resolved one. Null means "inherit
   * the provider's default_model" — the same value the Settings form must show in
   * its model field, so a save that does not touch the model cannot clear a
   * pinned one (#523 P3 review A2).
   */
  model: string | null
  /** What the resolver will actually call: `model ?? provider.default_model`. */
  effective_model: string | null
  thinking_level: string | null
  /**
   * 'household' = an assignment row exists; 'none' = nothing configured.
   * This is the CONFIGURED dimension; `status` below is the USABLE one (a row
   * without a key is configured but needs setup).
   */
  source: 'household' | 'none'
}

export type HouseholdAiConfig = {
  providers: HouseholdProvider[]
  capabilities: Record<Capability, HouseholdCapabilityAssignment>
  /** The resolver's truth per capability: 'household' or 'none' (402). */
  status: Record<Capability, 'household' | 'none'>
}

type HouseholdRow = {
  id: string
  label: string
  kind: ProviderKind
  preset: string | null
  base_url: string | null
  default_model: string | null
  encrypted_key: string | null
  created_at: string
  updated_at: string
  capability: Capability | null
  model: string | null
  thinking_level: string | null
}

// One read for the whole Settings → AI payload: providers LEFT JOIN their
// assignments. A provider row with no assignment appears once with a NULL
// capability; a provider assigned to all three appears three times.
const HOUSEHOLD_CONFIG_SQL = `SELECT p.id AS id,
        p.label AS label,
        p.kind AS kind,
        p.preset AS preset,
        p.base_url AS base_url,
        p.default_model AS default_model,
        p.encrypted_key AS encrypted_key,
        p.created_at AS created_at,
        p.updated_at AS updated_at,
        c.capability AS capability,
        c.model AS model,
        c.thinking_level AS thinking_level
   FROM ai_providers p
   LEFT JOIN ai_capabilities c
          ON c.provider_id = p.id AND c.household_id = p.household_id
  WHERE p.household_id = ?
  ORDER BY p.created_at, p.id, c.capability`

function emptyCapability(): HouseholdCapabilityAssignment {
  return {
    provider_id: null,
    provider_label: null,
    model: null,
    effective_model: null,
    thinking_level: null,
    source: 'none',
  }
}

/**
 * The additive `ai_providers` / `ai_capabilities` / `ai_status` block of
 * `GET /api/settings` (P1). Reads the household's rows once; `status` is
 * computed through the SAME usability rule as `resolveAccess` (endpoint +
 * decrypt), so the payload cannot claim a capability the resolver would refuse.
 *
 * The decrypt is a READ-ONLY one (`reseal: false`): a GET must not write, so a
 * legacy `v1:` row is migrated by the next real provider call instead.
 */
export async function loadHouseholdAiConfig(
  env: Env['Bindings'],
  householdId: string
): Promise<HouseholdAiConfig> {
  const { results } = await env.DB.prepare(HOUSEHOLD_CONFIG_SQL)
    .bind(householdId)
    .all<HouseholdRow>()

  const providers = new Map<string, HouseholdProvider>()
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [capability, emptyCapability()])
  ) as Record<Capability, HouseholdCapabilityAssignment>

  for (const row of results ?? []) {
    if (!providers.has(row.id)) {
      providers.set(row.id, {
        id: row.id,
        label: row.label,
        kind: row.kind,
        base_url: row.base_url,
        default_model: normalizeModel(row.default_model),
        has_key: row.encrypted_key != null && row.encrypted_key !== '',
        created_at: row.created_at,
        updated_at: row.updated_at,
      })
    }
    if (row.capability) {
      // The payload reports the EFFECTIVE model (capability ?? provider
      // default) so the UI shows what the resolver will call, not the raw
      // column. `source` stays 'household' because the assignment exists;
      // `status` below is the usable dimension.
      capabilities[row.capability] = {
        provider_id: row.id,
        provider_label: row.label,
        // The column and the resolved value are reported separately: the form
        // edits the column (blank = inherit) and the status line shows what a
        // call will use (#523 P3 review A2).
        model: normalizeModel(row.model),
        effective_model: effectiveModel(row),
        thinking_level: row.thinking_level,
        source: 'household',
      }
    }
  }

  const status = Object.fromEntries(
    CAPABILITIES.map((capability) => [capability, 'none'])
  ) as Record<Capability, 'household' | 'none'>

  for (const row of results ?? []) {
    if (!row.capability) continue
    // The SAME usability rule the resolver applies (key + endpoint + model), so
    // this payload can never claim a capability `resolveAccess` would refuse.
    if (!rowUsable(row)) continue
    try {
      if (
        (await decryptProviderKey(
          env,
          { id: row.id, encrypted_key: row.encrypted_key },
          { reseal: false }
        )) != null
      ) {
        status[row.capability] = 'household'
      }
    } catch {
      // An undecryptable key is "not configured" here too — the payload never
      // surfaces a key or an error, and Settings shows "needs setup".
    }
  }

  return { providers: [...providers.values()], capabilities, status }
}
