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
  nullable,
  regex,
  union,
  literal,
  array,
  integer,
  check,
  trim,
} from 'valibot'
import type { PersonaCopyKey } from './lib/persona.js'

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
  // Unit price (per-piece HARGA), canonical under #518 Option B.
  price: pipe(number(), integer(), minValue(0)),
  // The receipt's printed line total, when it shows one (#518 Q2). Absent or
  // null → the server computes qty × price and persists that; the client's
  // grand total is never trusted (Q3).
  line_total: optional(nullable(pipe(number(), integer(), minValue(0)))),
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

// --- persona copy rewrite (#523 P5, plan §6 P5) ------------------------------
//
// The browser sends the two role names and the interface strings it wants
// rewritten; the prompt, the provider row and the key all stay server-side.
// Both halves are UNTRUSTED text (lib/persona.ts wraps them in JSON data blocks
// and tells the model to treat them as content), so they are length-capped:
// a role is a couple of words, and a copy line that outgrows this is not an
// interface string any more. `copy` is a strict object of the nine
// `persona.*` slots the UI renders — an unknown key is a 400, so a client
// cannot widen the rewrite with slots of its own.
const PERSONA_ROLE = pipe(string(), trim(), minLength(1), maxLength(200))
const PERSONA_COPY_VALUE = pipe(string(), trim(), minLength(1), maxLength(400))

// `satisfies Record<PersonaCopyKey, …>` ties this object to the canonical key
// list in lib/persona.ts at COMPILE time: a slot added there (or renamed) fails
// the type check here instead of being accepted and silently never rewritten.
const personaCopyEntries = {
  homeLead: optional(PERSONA_COPY_VALUE),
  inventoryLead: optional(PERSONA_COPY_VALUE),
  planLeadNoKey: optional(PERSONA_COPY_VALUE),
  planLead: optional(PERSONA_COPY_VALUE),
  historyLead: optional(PERSONA_COPY_VALUE),
  receiptLead: optional(PERSONA_COPY_VALUE),
  settingsLead: optional(PERSONA_COPY_VALUE),
  assistantGreeting: optional(PERSONA_COPY_VALUE),
  assistantQuestion: optional(PERSONA_COPY_VALUE),
} satisfies Record<PersonaCopyKey, unknown>

export const personaCopySchema = pipe(
  strictObject({
    user_role: PERSONA_ROLE,
    ai_role: PERSONA_ROLE,
    // The language the base copy is written in; it selects the prompt template
    // too, so a rewrite in Indonesian is instructed in Indonesian.
    language: optional(picklist(['en', 'id'])),
    copy: strictObject(personaCopyEntries),
  }),
  check(
    (input) => Object.values(input.copy).some((value) => value !== undefined),
    'Send at least one copy entry to rewrite'
  )
)
