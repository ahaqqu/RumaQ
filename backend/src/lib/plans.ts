import {
  completeText,
  AiError,
  parseJsonResponse,
  type AiAccessHandle,
  type AiCall,
  type AiCtx,
  type TokenUsage,
} from './ai/index.js'
import {
  object,
  parse,
  strictObject,
  string,
  number,
  picklist,
  optional,
  array,
  pipe,
  minLength,
  minValue,
  maxValue,
  nullish,
  check,
  type InferOutput,
} from 'valibot'
import { MONEY_MAX, QTY_MAX } from './money-bounds.js'

/** One generated plan line, as the save route consumes it. */
export type PlanItem = {
  name: string
  qty: number
  unit: string
  store_id: string | null
  price_estimate: number | null
  why: string
}

export const planGenerateResponseSchema = object({
  items: array(
    object({
      name: pipe(string(), minLength(1)),
      qty: pipe(number(), minValue(0)),
      unit: string(),
      store_id: nullish(string()),
      price_estimate: nullish(number()),
      // Optional in the save contract (`planCreateSchema`) too: a line without
      // its "why" is still a usable plan, and the old answer mapper defaulted
      // it. Requiring it here made a cosmetic omission fatal to the whole plan.
      why: optional(string()),
    })
  ),
})

/** The model answer's shape, as this feature validates it. */
type PlanGenerateResponse = InferOutput<typeof planGenerateResponseSchema>

export const planItemPatchSchema = strictObject({
  status: picklist(['bought', 'skipped']),
})

export const planCreateSchema = strictObject({
  items: pipe(
    array(
      pipe(
        object({
          name: pipe(string(), minLength(1)),
          // #586: qty and price_estimate are the two fields the server
          // multiplies into plans.total_estimate (Σ estimate × qty) — and
          // into the check-off purchase's line amount — so they carry the
          // same caps as the purchase line's qty/price (shared constants,
          // lib/money-bounds.ts). The generate ANSWER schema above stays
          // uncapped on purpose: one absurd model line must not sink the
          // whole plan (502) — the draft is reviewable, and the save is
          // where the persisted contract is enforced.
          qty: pipe(number(), minValue(0), maxValue(QTY_MAX)),
          unit: string(),
          // The browser client forwards the generate response's fields verbatim
          // (Plan.jsx), and that response carries explicit nulls — for "no
          // store" (#519) and for an estimate the model omitted (the prompt
          // marks price_estimate optional). JSON has no undefined, so `optional`
          // alone 400ed the whole save on either; plan_items.store_id is a
          // nullable column and the UI groups null stores under "Other stores",
          // so null IS the established no-store value.
          store_id: nullish(string()),
          // #586: same money cap as the purchase line's line_total/price.
          // R587-A2: minValue(0) — a negative estimate would SUBTRACT from
          // plans.total_estimate; purchase-side money fields both carry it.
          price_estimate: nullish(pipe(number(), minValue(0), maxValue(MONEY_MAX))),
          why: optional(string()),
          // Set when the estimate was grounded on a real price observation
          // (§5.4). The browser client sends an explicit null for ungrounded
          // items, so this is nullish rather than merely optional.
          price_observation_id: nullish(string()),
        }),
        // R587-A1: the check-off INSERT (PATCH …/items/:id → bought) persists
        // price_estimate × qty as the line amount (lineTotalOf with
        // line_total: null), so a saved plan line must obey the same money
        // bound as the purchase line's computed fallback. The plan save is
        // the only wire a check-off-able row can be born through — one check
        // here keeps the invariant on both INSERT paths, receipt + check-off.
        check(
          (line) =>
            line.price_estimate == null ? true : line.price_estimate * line.qty <= MONEY_MAX,
          'The computed check-off line total (price_estimate × qty) exceeds the money bound'
        )
      )
    ),
    minLength(1)
  ),
})

// Shape of a successful grounding match (see lib/grounding.ts) — declared here
// so the plan route and the grounding lib agree on it without a cycle.
export type GroundingMatch = {
  productKey: string
  productName: string
  confidence: number
}

export function buildPlanPrompt(
  lowStock: Array<{
    name: string
    qty: number
    unit: string | null
    run_out_days: number | null
    expiry_date: string | null
  }>,
  expiring: Array<{
    name: string
    qty: number
    unit: string | null
    expiry_date: string | null
  }>,
  recentPurchases: Array<{ name: string; store_label: string | null }>,
  stores: Array<{ id: string; label: string }>,
  currency: string
): string {
  // #519: the model is asked for a store_id, so it must SEE the ids — labels
  // alone forced it to invent one, and POST /api/plans 400s on an unknown id.
  const storeLines = stores.map((s) => `- ${s.id} — ${s.label}`).join('\n')
  const lowStockLines = lowStock
    .map(
      (s) =>
        `${s.name} (qty: ${s.qty}${s.unit ? ' ' + s.unit : ''}, runs out in ${s.run_out_days ?? '?'} days)`
    )
    .join('\n')
  const expiringLines = expiring
    .map((s) => `${s.name} (qty: ${s.qty}${s.unit ? ' ' + s.unit : ''}, expires: ${s.expiry_date})`)
    .join('\n')
  const purchaseLines = recentPurchases
    .map((p) => `${p.name}${p.store_label ? ' @ ' + p.store_label : ''}`)
    .join('\n')

  return `You are a shopping plan assistant. Based on the household's current inventory and purchase history, generate a shopping plan.

Available stores (store_id — label):
${storeLines || 'No stores configured'}

Low-stock items (running out within 7 days):
${lowStockLines || 'None'}

Expiring items (within 7 days):
${expiringLines || 'None'}

Recent purchases (last 30 days) — items the household regularly buys:
${purchaseLines || 'None'}

Return ONLY valid JSON in this exact format:
{
  "items": [
    {
      "name": "Item name",
      "qty": 12,
      "unit": "pcs",
      "store_id": "the exact store_id from the list above (or null if no store fits)",
      "price_estimate": 10000,
      "why": "Reason for suggesting (e.g. 'running out in 3 days', 'expires in 2 days', 'not bought in 30 days')"
    }
  ]
}

Rules:
- Suggest items that are running low or expiring soon.
- Include items from purchase history that may need restocking.
- Group items by store where possible using the store ids above. store_id must be exactly one of the listed ids — never invent one; if no store fits or none are listed, set store_id to null.
- Cap at 50 items maximum.
- price_estimate is optional — provide a rough estimate in ${currency} if possible. price_estimate is the per-item unit price — what ONE unit costs, not the line total — and the server multiplies it by qty.
- The "why" field explains why the item is suggested.
- Include a sensible quantity based on past purchase patterns.
- Do NOT include any text outside the JSON.`
}

export type GeneratedPlan = {
  items: PlanItem[]
  call: AiCall
  usage: TokenUsage
}

/**
 * One plan generation through the door (#523 P4): the caller has resolved the
 * `reasoning` capability. The prompt is product policy and stays here; the
 * answer goes through the ONE JSON extraction policy (`parseJsonResponse`,
 * plan §2.5 — the previous inline `content.match(/\{...\}/)` copy is gone) and
 * then through this feature's own schema (planGenerateResponseSchema), which is
 * the plan route's validation contract.
 *
 * An answer that fails either gate is an `invalid_response` CARRYING the call's
 * bill: the provider read the prompt and answered, so the route records the
 * attempt (plan §2.2). A plain error here would silently drop that usage row.
 */
export async function generateAiPlan(
  ai: AiCtx & { access: AiAccessHandle },
  lowStock: Array<{
    name: string
    qty: number
    unit: string | null
    run_out_days: number | null
    expiry_date: string | null
  }>,
  expiring: Array<{
    name: string
    qty: number
    unit: string | null
    expiry_date: string | null
  }>,
  recentPurchases: Array<{ name: string; store_label: string | null }>,
  stores: Array<{ id: string; label: string }>,
  currency: string
): Promise<GeneratedPlan> {
  // #519: the ids the prompt lists are the caller's household-scoped stores
  // query, so membership in this set IS the household-scope check — a
  // hallucinated id and another household's id both miss it and fall back to
  // the same null a "no store" line already carries (nullable column, the
  // save route binds null, the UI groups null under "Other stores").
  const householdStoreIds = new Set(stores.map((s) => s.id))
  const prompt = buildPlanPrompt(lowStock, expiring, recentPurchases, stores, currency)
  const systemPrompt = `You are a helpful shopping plan assistant. Generate concise, practical shopping plans in JSON format.`

  const result = await completeText({
    env: ai.env,
    userId: ai.userId,
    householdId: ai.householdId,
    access: ai.access,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
  })

  let parsed: PlanGenerateResponse
  try {
    parsed = parse(planGenerateResponseSchema, parseJsonResponse<unknown>(result.text))
  } catch {
    throw new AiError('invalid_response', 'The AI answer was not a usable shopping plan', {
      call: result.call,
      usage: result.usage,
    })
  }

  // The prompt caps the list at 50; the slice is the belt, not the policy.
  const items = parsed.items.slice(0, 50).map((it) => ({
    name: it.name,
    qty: it.qty,
    unit: it.unit,
    // Unknown store_id → null: the plan must stay generatable (and savable)
    // when the model misbehaves; the save route's own household-scoped 400
    // then never fires for an AI answer (#519).
    store_id: it.store_id != null && householdStoreIds.has(it.store_id) ? it.store_id : null,
    price_estimate: it.price_estimate != null ? Math.round(it.price_estimate) : null,
    // `why` is optional in the answer (it is optional in the save contract
    // too); an item without one still belongs in the plan.
    why: it.why ?? '',
  }))

  return { items, call: result.call, usage: result.usage }
}

export function normalizeItemName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}
