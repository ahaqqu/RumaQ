// Capability resolution — the household-scoped ladder (ahaqqu/RumaQ#523,
// plan §5.1). This module owns the ai_providers / ai_capabilities reads: the
// resolver, and the settings read model the API serializes.
//
// The ladder is TWO outcomes, by owner decision (D8): an assignment that
// resolves to a usable provider, or null. There is no server branch, no env
// key, no platform default. An unconfigured capability is unconfigured; the
// routes map null to 402.
//
// The household is the lookup key, not the user: two members of the same
// household resolve the SAME row (and therefore the same key), which is what
// D1 asks for. The acting user id never enters these queries.

import type { Env } from '../../types.js'
import {
  CAPABILITIES,
  THINKING_LEVELS,
  type AiAccessHandle,
  type AiCtx,
  type Capability,
  type ProviderKind,
  type ThinkingLevel,
} from './types.js'
import { presetEndpoint } from './presets.js'
import { decryptProviderKey } from './credentials.js'

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
// this a single-row seek; provider_id is indexed on the provider side.
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
   JOIN ai_providers p ON p.id = c.provider_id
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

/** The endpoint a row resolves to: its own base URL wins over the preset's. */
function resolvedEndpoint(row: Pick<AccessRow, 'base_url' | 'preset' | 'kind'>): string | null {
  return row.base_url ?? presetEndpoint(row.preset, row.kind)
}

/**
 * Can this row serve a call at all? A missing key is handled by the caller; a
 * missing endpoint is only fatal for kinds that have no canonical one
 * ('openai-compatible' without a preset, 'questions' always custom).
 */
function endpointResolvable(row: Pick<AccessRow, 'base_url' | 'preset' | 'kind'>): boolean {
  if (row.kind === 'questions') return row.base_url != null
  if (row.kind === 'openai-compatible') return resolvedEndpoint(row) != null
  // anthropic / gemini adapters own their canonical endpoint; anything else is
  // not a wire this gateway speaks (the CHECK makes that unreachable in D1).
  return row.kind === 'anthropic' || row.kind === 'gemini'
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
  const model = normalizeModel(row.model) ?? normalizeModel(row.default_model)
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
  return {
    capability: row.capability,
    call: {
      capability: row.capability,
      householdId: ctx.householdId,
      providerKind: row.kind,
      providerId: row.provider_id,
      model,
      // D9: every handle v1 can return is household-funded. The day a platform
      // provider exists, this is the ONLY place that decides it.
      funding: 'household',
    },
    apiKey,
    baseUrl: resolvedEndpoint(row),
    preset: row.preset,
    thinkingLevel: normalizeThinkingLevel(row.thinking_level),
  }
}

/**
 * Resolve one capability for the household the request acts in.
 *
 * Two outcomes only:
 *   - the household's assignment points at a keyed, resolvable provider →
 *     a handle;
 *   - anything else (no assignment, no key, unusable endpoint, undecryptable
 *     ciphertext) → null, which the routes map to the normal 402.
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
  model: string | null
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
    thinking_level: null,
    source: 'none',
  }
}

/**
 * The additive `ai_providers` / `ai_capabilities` / `ai_status` block of
 * `GET /api/settings` (P1). Reads the household's rows once; `status` is
 * computed through the SAME usability rule as `resolveAccess` (endpoint +
 * decrypt), so the payload cannot claim a capability the resolver would refuse.
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
        model: normalizeModel(row.model) ?? normalizeModel(row.default_model),
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
    const provider = providers.get(row.id)
    if (!provider?.has_key) continue
    if (!endpointResolvable(row)) continue
    // Same model rule as resolveAccess: capability.model ?? provider default.
    if (normalizeModel(row.model) == null && normalizeModel(row.default_model) == null) continue
    try {
      if (
        (await decryptProviderKey(env, { id: row.id, encrypted_key: row.encrypted_key })) != null
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
