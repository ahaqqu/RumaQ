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
  array,
  integer,
} from 'valibot'

export const settingsPatchSchema = strictObject({
  ai_provider: optional(
    picklist(['opencode', 'openai', 'anthropic', 'gemini', 'ollama', 'custom'])
  ),
  ai_key: optional(pipe(string(), minLength(1))),
  ai_base_url: optional(pipe(string(), maxLength(500))),
  ai_model: optional(pipe(string(), maxLength(200))),
  persona_user_role: optional(string()),
  persona_ai_role: optional(string()),
  persona_enabled: optional(boolean()),
  motion_preference: optional(picklist(['none', 'reduced', 'standard'])),
  language: optional(picklist(['id', 'en'])),
  theme_hue: optional(number()),
})

export const locationSchema = object({
  label: pipe(string(), minLength(1), maxLength(100)),
})

export const storeSchema = object({
  label: pipe(string(), minLength(1), maxLength(100)),
})

export const aiKeyTestSchema = object({
  provider: picklist(['opencode', 'openai', 'anthropic', 'gemini', 'ollama', 'custom']),
  key: optional(pipe(string(), minLength(1))),
  base_url: optional(pipe(string(), minLength(1), maxLength(500))),
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
