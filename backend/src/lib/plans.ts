import type { PlanItem } from './ai.js'
import { completeText, type AiCallOpts } from './ai.js'
import {
  object,
  strictObject,
  string,
  number,
  picklist,
  optional,
  array,
  pipe,
  minLength,
  minValue,
  nullish,
} from 'valibot'

export const planGenerateResponseSchema = object({
  items: array(
    object({
      name: pipe(string(), minLength(1)),
      qty: pipe(number(), minValue(0)),
      unit: string(),
      store_id: nullish(string()),
      price_estimate: nullish(number()),
      why: string(),
    })
  ),
})

export const planItemPatchSchema = strictObject({
  status: picklist(['bought', 'skipped']),
})

export const planCreateSchema = strictObject({
  items: pipe(
    array(
      object({
        name: pipe(string(), minLength(1)),
        qty: pipe(number(), minValue(0)),
        unit: string(),
        store_id: optional(string()),
        price_estimate: optional(number()),
        why: optional(string()),
        // Set when the estimate was grounded on a real price observation
        // (§5.4). The browser client sends an explicit null for ungrounded
        // items, so this is nullish rather than merely optional.
        price_observation_id: nullish(string()),
      })
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
  stores: Array<{ label: string }>,
  currency: string
): string {
  const storeLines = stores.map((s) => `- ${s.label}`).join('\n')
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

Available stores:
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
      "qty": 1,
      "unit": "pcs",
      "store_id": "store id from the list above (or null if unknown)",
      "price_estimate": 10000,
      "why": "Reason for suggesting (e.g. 'running out in 3 days', 'expires in 2 days', 'not bought in 30 days')"
    }
  ]
}

Rules:
- Suggest items that are running low or expiring soon.
- Include items from purchase history that may need restocking.
- Group items by store where possible using the store labels above. If a store is unknown, set store_id to null.
- Cap at 50 items maximum.
- price_estimate is optional — provide a rough estimate in ${currency} if possible.
- The "why" field explains why the item is suggested.
- Include a sensible quantity based on past purchase patterns.
- Do NOT include any text outside the JSON.`
}

export async function generateAiPlan(
  provider: string,
  apiKey: string,
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
  currency: string,
  opts?: AiCallOpts
): Promise<PlanItem[]> {
  const promptStores = stores.map((s) => ({ label: s.label }))
  const prompt = buildPlanPrompt(lowStock, expiring, recentPurchases, promptStores, currency)
  const systemPrompt = `You are a helpful shopping plan assistant. Generate concise, practical shopping plans in JSON format.`

  const content = await completeText(provider, apiKey, systemPrompt, prompt, opts)

  const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}') as Record<string, unknown>
  const items = (parsed.items || []) as Record<string, unknown>[]

  return items.slice(0, 50).map((it) => ({
    name: String(it.name || ''),
    qty: Number(it.qty) || 1,
    unit: String(it.unit || 'pcs'),
    store_id: it.store_id ? String(it.store_id) : null,
    price_estimate: it.price_estimate != null ? Math.round(Number(it.price_estimate)) : null,
    why: String(it.why || ''),
  }))
}

export function normalizeItemName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}
