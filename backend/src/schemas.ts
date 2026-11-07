import {
  strictObject,
  object,
  string,
  picklist,
  boolean,
  number,
  optional,
  pipe,
  minLength,
  maxLength,
  minValue,
  regex,
  union,
  literal,
  array,
  integer,
} from 'valibot'

// Model names go into provider request bodies and (for Gemini) the URL path,
// so restrict them to the characters real model ids use. Allowlist, not
// blocklist: anything unusual is rejected rather than smuggled through.
// The empty string is allowed and means "use the provider default".
const AI_MODEL_REGEX = /^(?:[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199})?$/

// ahaqqu/RumaQ#523 P3 (plan §4.3): the six legacy `user_settings.ai_*` fields
// are GONE here together with the columns migration 0042 drops. A payload that
// still sends `ai_key` is now a 400 — the dead write of P1/P2 no longer exists,
// and the AI surface is /api/ai/providers + /api/ai/capabilities.
export const settingsPatchSchema = strictObject({
  persona_user_role: optional(string()),
  persona_ai_role: optional(string()),
  persona_enabled: optional(boolean()),
  motion_preference: optional(picklist(['none', 'reduced', 'standard'])),
  language: optional(picklist(['id', 'en'])),
  theme_hue: optional(number()),
})

// --- AI gateway settings (#523 P3, plan §4.1–§4.2) ---------------------------
//
// The wire kinds and the capability enum are fixed vocabularies (D2/D5), so they
// are picklists. A PRESET is data (lib/ai/presets.ts): the schema only bounds its
// id, because adding a vendor must be a row, never a schema edit.
const PROVIDER_LABEL = pipe(string(), minLength(1), maxLength(60))
const AI_THINKING = union([picklist(['low', 'medium', 'high']), literal('')])

export const aiProviderCreateSchema = strictObject({
  label: PROVIDER_LABEL,
  kind: picklist(['openai-compatible', 'anthropic', 'gemini', 'questions']),
  preset: optional(pipe(string(), maxLength(40))),
  // HTTPS-only and length-capped; the trimming/trailing-slash rule lives with
  // the write in lib/ai/provider-settings.ts.
  base_url: optional(pipe(string(), maxLength(500))),
  default_model: optional(pipe(string(), maxLength(200), regex(AI_MODEL_REGEX))),
  // Write-only: never returned by any GET for any role (has_key is the signal).
  api_key: pipe(string(), minLength(1), maxLength(4096)),
})

export const aiProviderPatchSchema = strictObject({
  label: optional(PROVIDER_LABEL),
  kind: optional(picklist(['openai-compatible', 'anthropic', 'gemini', 'questions'])),
  // '' clears the column (the old ai_base_url rule); omitted leaves it.
  base_url: optional(pipe(string(), maxLength(500))),
  default_model: optional(pipe(string(), maxLength(200), regex(AI_MODEL_REGEX))),
  // '' clears the stored key, omitted keeps it, a value re-seals it (v2:).
  api_key: optional(pipe(string(), maxLength(4096))),
})

export const aiCapabilityAssignSchema = strictObject({
  provider_id: pipe(string(), minLength(1)),
  // '' / omitted = inherit the provider's default_model (plan §4.5).
  model: optional(pipe(string(), maxLength(200), regex(AI_MODEL_REGEX))),
  thinking_level: optional(AI_THINKING),
})

export const locationSchema = object({
  label: pipe(string(), minLength(1), maxLength(100)),
})

export const storeSchema = object({
  label: pipe(string(), minLength(1), maxLength(100)),
})

export const stockPatchSchema = strictObject({
  qty: optional(pipe(number(), minValue(0))),
  unit: optional(string()),
  location_id: optional(string()),
  expiry_date: optional(string()),
  name: optional(string()),
})

export const purchaseItemSchema = object({
  name: pipe(string(), minLength(1)),
  qty: pipe(number(), minValue(0)),
  unit: string(),
  price: pipe(number(), integer(), minValue(0)),
  item_id: optional(string()),
})

export const purchaseCreateSchema = strictObject({
  store_id: optional(string()),
  date: pipe(string(), minLength(1)),
  receipt_image_key: optional(string()),
  items: pipe(array(purchaseItemSchema), minLength(1)),
})

export const chatSchema = object({
  message: pipe(string(), minLength(1), maxLength(4000)),
  history: optional(
    pipe(
      array(
        object({
          role: picklist(['user', 'assistant']),
          content: pipe(string(), minLength(1), maxLength(4000)),
        })
      ),
      maxLength(10)
    )
  ),
})
