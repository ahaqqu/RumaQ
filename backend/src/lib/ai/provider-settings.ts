// Provider + capability SETTINGS (ahaqqu/RumaQ#523 P3, plan §4). Every write
// that touches a provider row or its sealed key lives here, inside the door:
// this is the only module that calls `encryptProviderKey` (credentials.ts) and
// the only one that runs a connection probe (the adapters' `probe`).
//
// The ROUTES (apps/api.ts) own HTTP: they call `requireOwner` first, validate
// the body with Valibot, then call one function below and map
// `AiProviderSettingsError.status` onto the response. Nothing in this module
// knows about Hono.
//
// Invariants enforced here, not in the UI (plan §4.2):
//   - one household's rows only (`WHERE id = ? AND household_id = ?`): a leaked
//     id from another household is a 404, never a 403 that confirms it exists;
//   - case-insensitive label uniqueness is the database's (409 on the way out);
//   - a provider cannot be assigned to a capability its wire cannot serve;
//   - `vision` takes no thinking level, and a `questions` row takes none either;
//   - an assignment needs a usable row: a stored key and a resolvable endpoint;
//   - clearing a key (or the endpoint) of an ASSIGNED provider is refused — the
//     owner reassigns first rather than the capability silently going dark;
//   - at most 10 providers per household;
//   - no response path returns `encrypted_key`: `has_key` is the only signal.

import type { Env } from '../../types.js'
import { CAPABILITIES, type Capability, type ProviderKind, type ThinkingLevel } from './types.js'
import { PRESETS, presetById, presetEndpoint } from './presets.js'
import { decryptProviderKey, encryptProviderKey } from './credentials.js'
import { adapterFor } from './adapters/registry.js'
import { AdapterError } from './adapters/types.js'
import { withTimeout } from './signal.js'
import { loadHouseholdAiConfig, type HouseholdCapabilityAssignment } from './capabilities.js'

/** ahaqqu/RumaQ#523 §4.1: a household may hold ten providers, no more. */
export const MAX_AI_PROVIDERS = 10

/** A provider test is one provider request; it gets a short leash. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * Every refusal the settings routes can produce, carrying the HTTP status the
 * route returns. Typed so the route stays a mapping table instead of a pile of
 * `if` statements, and so a test can assert the status without parsing prose.
 */
export class AiProviderSettingsError extends Error {
  readonly status: 400 | 404 | 409

  constructor(status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = 'AiProviderSettingsError'
    this.status = status
  }
}

const badRequest = (message: string) => new AiProviderSettingsError(400, message)
const notFound = (message: string) => new AiProviderSettingsError(404, message)
const conflict = (message: string) => new AiProviderSettingsError(409, message)

// --- shapes -----------------------------------------------------------------

/** One provider row as the API serialises it — never the key. */
export type ProviderRow = {
  id: string
  label: string
  kind: ProviderKind
  preset: string | null
  base_url: string | null
  default_model: string | null
  has_key: boolean
  created_at: string
  updated_at: string
}

/** The catalog a user MAY add. Seeds nothing, preselects nothing (plan §4.1/§4.5). */
export type PresetRow = { id: string; label: string; kind: ProviderKind; base_url: string | null }

export type CreateProviderInput = {
  label: string
  kind: ProviderKind
  preset?: string | null
  base_url?: string | null
  default_model?: string | null
  api_key: string
}

export type UpdateProviderInput = {
  label?: string
  kind?: ProviderKind
  base_url?: string | null
  default_model?: string | null
  api_key?: string
}

export type AssignCapabilityInput = {
  provider_id: string
  model?: string | null
  /** '' is the API's "no thinking level" value, the same as an omitted field. */
  thinking_level?: ThinkingLevel | '' | null
}

type ProviderDbRow = ProviderRow & { encrypted_key: string | null }

const PROVIDER_SELECT = `SELECT id, label, kind, preset, base_url, default_model,
        encrypted_key, created_at, updated_at
   FROM ai_providers`

function serializeProvider(row: ProviderDbRow): ProviderRow {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    preset: row.preset,
    base_url: row.base_url,
    default_model: row.default_model,
    has_key: row.encrypted_key != null && row.encrypted_key !== '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function normalizeModel(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * Trim, strip trailing slashes, and enforce the HTTPS-only rule (plan §4.2,
 * owner decision §7.2 #3: no private-network HTTP, no TEST_MODE exception).
 * Returns null for "no base URL" (cleared).
 */
function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw badRequest('Invalid AI base URL')
  }
  if (parsed.protocol !== 'https:') {
    throw badRequest('AI base URL must use HTTPS')
  }
  return trimmed.replace(/\/+$/, '')
}

/** The endpoint a row resolves to: its own base URL wins over the preset's. */
function rowEndpoint(row: Pick<ProviderDbRow, 'base_url' | 'preset' | 'kind'>): string | null {
  return row.base_url ?? presetEndpoint(row.preset, row.kind)
}

/**
 * Is this row able to serve a call at all? Key + endpoint, the two conditions
 * `resolveAccess` refuses on besides the model. The model is deliberately NOT
 * part of this: a provider row with no default model is fine — the capability
 * may carry its own, and the "both blank" state is a normal not-configured
 * assignment, not a save-time error (plan §4.2/§4.5).
 */
function assertAssignableProvider(row: ProviderDbRow): void {
  if (!row.encrypted_key) {
    throw badRequest('This provider has no API key yet — add a key before assigning it')
  }
  if (!rowEndpoint(row)) {
    throw badRequest('This provider needs a base URL before a capability can use it')
  }
}

/**
 * The capability row's shape check (plan §4.2). `vision` has no reasoning knob,
 * and a typed provider has no such field either, so both are refused at save
 * time rather than silently dropped by an adapter.
 */
function assertThinkingAllowed(
  kind: ProviderKind,
  capability: Capability,
  thinking: string | null
) {
  if (!thinking) return
  if (capability === 'vision') {
    throw badRequest('The vision capability has no thinking level')
  }
  if (kind === 'questions') {
    throw badRequest('A typed-decision provider has no thinking level')
  }
}

/** `supports()` is the save-time half of the capability matrix (plan §2.4). */
function assertKindSupports(kind: ProviderKind, capability: Capability): void {
  if (!adapterFor(kind).supports(capability)) {
    throw badRequest(`A ${kind} provider cannot serve the ${capability} capability`)
  }
}

/** The capability assignments that point at one provider, for cascade reporting. */
async function assignedCapabilities(
  env: Env['Bindings'],
  householdId: string,
  providerId: string
): Promise<Capability[]> {
  const { results } = await env.DB.prepare(
    'SELECT capability FROM ai_capabilities WHERE household_id = ? AND provider_id = ? ORDER BY capability'
  )
    .bind(householdId, providerId)
    .all<{ capability: Capability }>()
  return (results ?? []).map((row) => row.capability)
}

async function providerById(
  env: Env['Bindings'],
  householdId: string,
  providerId: string
): Promise<ProviderDbRow> {
  // Both binds on purpose: the household is part of the identity, so a row from
  // another household is indistinguishable from a missing one (404, plan §4.2).
  const row = await env.DB.prepare(`${PROVIDER_SELECT} WHERE id = ? AND household_id = ?`)
    .bind(providerId, householdId)
    .first<ProviderDbRow>()
  if (!row) throw notFound('AI provider not found')
  return row
}

// --- reads ------------------------------------------------------------------

export function listPresets(): PresetRow[] {
  return PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    kind: preset.kind,
    base_url: preset.endpoint,
  }))
}

/** The household's provider rows, oldest first. No key material, ever. */
export async function listProviders(
  env: Env['Bindings'],
  householdId: string
): Promise<ProviderRow[]> {
  const { results } = await env.DB.prepare(
    `${PROVIDER_SELECT} WHERE household_id = ? ORDER BY created_at, id`
  )
    .bind(householdId)
    .all<ProviderDbRow>()
  return (results ?? []).map(serializeProvider)
}

// --- provider writes --------------------------------------------------------

/**
 * Create one provider. The row id is minted FIRST so the key can be sealed with
 * `ai_provider:<id>` as additional authenticated data (D10) — the id is never
 * derived from the ciphertext.
 */
export async function createProvider(
  env: Env['Bindings'],
  householdId: string,
  input: CreateProviderInput
): Promise<ProviderRow> {
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM ai_providers WHERE household_id = ?'
  )
    .bind(householdId)
    .first<{ count: number }>()
  if ((count?.count ?? 0) >= MAX_AI_PROVIDERS) {
    throw badRequest(`A household can have at most ${MAX_AI_PROVIDERS} AI providers`)
  }

  // Valibot's minLength(1) passes a whitespace-only label; the column would
  // store '', so the trim happens here where every write path goes through.
  const label = input.label.trim()
  if (!label) throw badRequest('A provider needs a label')

  const preset = input.preset ?? null
  if (preset) {
    const catalog = presetById(preset)
    if (!catalog) throw badRequest(`Unknown AI provider preset: ${preset}`)
    if (catalog.kind !== input.kind) {
      throw badRequest(`Preset ${preset} speaks ${catalog.kind}, not ${input.kind}`)
    }
  }
  const baseUrl = normalizeBaseUrl(input.base_url)
  // A row needs an endpoint from somewhere: its own base URL or its preset's.
  // 'questions' never has a canonical one; a hand-configured
  // 'openai-compatible' row has no preset at all.
  if (
    !baseUrl &&
    !presetEndpoint(preset, input.kind) &&
    input.kind !== 'anthropic' &&
    input.kind !== 'gemini'
  ) {
    throw badRequest('This provider needs a base URL')
  }

  const duplicate = await env.DB.prepare(
    'SELECT id FROM ai_providers WHERE household_id = ? AND lower(label) = lower(?)'
  )
    .bind(householdId, label)
    .first<{ id: string }>()
  if (duplicate) throw conflict('A provider with that label already exists')

  const id = crypto.randomUUID()
  const encryptedKey = await encryptProviderKey(env, id, input.api_key)

  await env.DB.prepare(
    `INSERT INTO ai_providers
       (id, household_id, label, kind, preset, base_url, default_model, encrypted_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      householdId,
      label,
      input.kind,
      preset,
      baseUrl,
      normalizeModel(input.default_model),
      encryptedKey
    )
    .run()

  const row = await providerById(env, householdId, id)
  return serializeProvider(row)
}

/**
 * Update one provider. `api_key: ''` clears the key, an omitted `api_key` keeps
 * it, and `default_model: ''` / `base_url: ''` clear those columns.
 */
export async function updateProvider(
  env: Env['Bindings'],
  householdId: string,
  providerId: string,
  input: UpdateProviderInput
): Promise<ProviderRow> {
  const current = await providerById(env, householdId, providerId)
  const assigned = await assignedCapabilities(env, householdId, providerId)

  const nextKind = input.kind ?? current.kind

  // A kind change must not strand an existing assignment: the row has to keep
  // serving every capability it is already assigned to (400 on mismatch).
  if (nextKind !== current.kind) {
    for (const capability of assigned) {
      assertKindSupports(nextKind, capability)
    }
    // A typed wire has no reasoning knob, so moving an assigned row to
    // `questions` while an assignment still carries a thinking level would leave
    // a combination `assignCapability` already refuses at save time.
    if (nextKind === 'questions') {
      const withThinking = await env.DB.prepare(
        `SELECT capability FROM ai_capabilities
          WHERE household_id = ? AND provider_id = ? AND thinking_level IS NOT NULL
          ORDER BY capability`
      )
        .bind(householdId, providerId)
        .first<{ capability: Capability }>()
      if (withThinking) {
        throw badRequest(
          `A typed-decision provider has no thinking level — clear it on ${withThinking.capability} first`
        )
      }
    }
  }

  const nextLabel = input.label !== undefined ? input.label.trim() : undefined
  if (nextLabel !== undefined) {
    if (!nextLabel) throw badRequest('A provider needs a label')
    const duplicate = await env.DB.prepare(
      'SELECT id FROM ai_providers WHERE household_id = ? AND lower(label) = lower(?) AND id <> ?'
    )
      .bind(householdId, nextLabel, providerId)
      .first<{ id: string }>()
    if (duplicate) throw conflict('A provider with that label already exists')
  }

  const nextBaseUrl =
    input.base_url !== undefined ? normalizeBaseUrl(input.base_url) : current.base_url
  // The row must still resolve an endpoint after the edit — clearing the base
  // URL of a row whose preset has none would leave an unusable provider.
  if (!(nextBaseUrl ?? presetEndpoint(current.preset, nextKind))) {
    throw badRequest('This provider needs a base URL')
  }

  // Clearing the key of an assigned provider is a 409, not a silent downgrade
  // (plan §4.2): the capability would start answering 402 with no explanation.
  const clearsKey = input.api_key !== undefined && input.api_key.trim() === ''
  if (clearsKey && assigned.length > 0) {
    throw conflict(
      `This provider is used by ${assigned.join(', ')} — reassign or clear those capabilities first`
    )
  }

  const updates: string[] = []
  const params: unknown[] = []
  if (nextLabel !== undefined) {
    updates.push('label = ?')
    params.push(nextLabel)
  }
  if (input.kind !== undefined) {
    updates.push('kind = ?')
    params.push(input.kind)
  }
  if (input.base_url !== undefined) {
    updates.push('base_url = ?')
    params.push(nextBaseUrl)
  }
  if (input.default_model !== undefined) {
    updates.push('default_model = ?')
    params.push(normalizeModel(input.default_model))
  }
  if (input.api_key !== undefined) {
    updates.push('encrypted_key = ?')
    params.push(clearsKey ? null : await encryptProviderKey(env, providerId, input.api_key.trim()))
  }

  if (updates.length > 0) {
    params.push(providerId, householdId)
    await env.DB.prepare(
      `UPDATE ai_providers SET ${updates.join(', ')}, updated_at = datetime('now')
        WHERE id = ? AND household_id = ?`
    )
      .bind(...params)
      .run()
  }

  return serializeProvider(await providerById(env, householdId, providerId))
}

/**
 * Delete one provider and report which capabilities it was serving. The
 * assignments are deleted explicitly (instead of leaning on the FK cascade) so
 * the report and the write are the same deterministic pair in one batch, and
 * so the route is correct even where a test engine has FKs off.
 */
export async function deleteProvider(
  env: Env['Bindings'],
  householdId: string,
  providerId: string
): Promise<{ cleared: Capability[] }> {
  await providerById(env, householdId, providerId)
  const cleared = await assignedCapabilities(env, householdId, providerId)

  await env.DB.batch([
    env.DB.prepare('DELETE FROM ai_capabilities WHERE household_id = ? AND provider_id = ?').bind(
      householdId,
      providerId
    ),
    env.DB.prepare('DELETE FROM ai_providers WHERE id = ? AND household_id = ?').bind(
      providerId,
      householdId
    ),
  ])
  return { cleared }
}

// --- capability assignments -------------------------------------------------

function requireCapability(raw: string): Capability {
  if (!(CAPABILITIES as readonly string[]).includes(raw)) {
    throw badRequest(`Unknown capability: ${raw}`)
  }
  return raw as Capability
}

/**
 * Upsert one capability assignment. The capability becomes not-configured when
 * both the assignment's model and the provider's default are blank, which is a
 * normal state — nothing here invents a model (plan §4.5).
 */
export async function assignCapability(
  env: Env['Bindings'],
  householdId: string,
  rawCapability: string,
  input: AssignCapabilityInput
): Promise<{ capability: HouseholdCapabilityAssignment; status: 'household' | 'none' }> {
  const capability = requireCapability(rawCapability)
  const provider = await providerById(env, householdId, input.provider_id)
  assertKindSupports(provider.kind, capability)
  assertThinkingAllowed(provider.kind, capability, normalizeModel(input.thinking_level))
  assertAssignableProvider(provider)

  await env.DB.prepare(
    `INSERT INTO ai_capabilities (household_id, capability, provider_id, model, thinking_level)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (household_id, capability) DO UPDATE SET
       provider_id = excluded.provider_id,
       model = excluded.model,
       thinking_level = excluded.thinking_level,
       updated_at = datetime('now')`
  )
    .bind(
      householdId,
      capability,
      provider.id,
      normalizeModel(input.model),
      capability === 'vision' ? null : normalizeModel(input.thinking_level)
    )
    .run()

  return readCapability(env, householdId, capability)
}

/** Clear one assignment; the capability is not configured afterwards. Idempotent. */
export async function clearCapability(
  env: Env['Bindings'],
  householdId: string,
  rawCapability: string
): Promise<{ capability: HouseholdCapabilityAssignment; status: 'household' | 'none' }> {
  const capability = requireCapability(rawCapability)
  await env.DB.prepare('DELETE FROM ai_capabilities WHERE household_id = ? AND capability = ?')
    .bind(householdId, capability)
    .run()
  return readCapability(env, householdId, capability)
}

/**
 * The single capability entry of the Settings payload, through the SAME read
 * model `GET /api/settings` uses — so a write response can never report a
 * different effective model or status than the next read.
 */
async function readCapability(
  env: Env['Bindings'],
  householdId: string,
  capability: Capability
): Promise<{ capability: HouseholdCapabilityAssignment; status: 'household' | 'none' }> {
  const config = await loadHouseholdAiConfig(env, householdId)
  return { capability: config.capabilities[capability], status: config.status[capability] }
}

// --- connection test --------------------------------------------------------

export type ProviderTestResult = { ok: true; code?: undefined } | { ok: false; code: string }

/**
 * The owner-only connection test (plan §4.6). The stored key is decrypted, the
 * adapter owning the wire runs its free probe, and the answer is a code — never
 * the provider's body, which can echo request material back.
 */
export async function testProvider(
  env: Env['Bindings'],
  householdId: string,
  providerId: string
): Promise<ProviderTestResult> {
  const provider = await providerById(env, householdId, providerId)
  if (!provider.encrypted_key) {
    throw badRequest('This provider has no API key to test')
  }
  const endpoint = rowEndpoint(provider)
  if (!endpoint) {
    throw badRequest('This provider needs a base URL before it can be tested')
  }

  let apiKey: string
  try {
    apiKey = (await decryptProviderKey(env, provider)) ?? ''
  } catch {
    // No key material in the message, ever; the owner just learns to re-enter it.
    return { ok: false, code: 'unreadable_key' }
  }
  if (!apiKey) {
    throw badRequest('This provider has no API key to test')
  }

  const timeout = withTimeout(undefined, PROBE_TIMEOUT_MS)
  try {
    await adapterFor(provider.kind).probe({
      baseUrl: endpoint,
      model: normalizeModel(provider.default_model),
      apiKey,
      signal: timeout.signal,
    })
    return { ok: true }
  } catch (err) {
    if (err instanceof AdapterError) return { ok: false, code: err.code }
    // Never surface an unknown failure's message: it may carry the request.
    return { ok: false, code: 'provider_error' }
  } finally {
    timeout.dispose()
  }
}
