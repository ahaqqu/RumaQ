import { completeText, type AiCallOpts } from './ai.js'
import { buildSystemPrompt } from './persona.js'

type LowStockItem = {
  name: string
  qty: number
  unit: string | null
  run_out_days: number | null
}

type ExpiringItem = {
  name: string
  qty: number
  unit: string | null
  expiry_date: string | null
}

type ActivePlanItem = {
  name: string
  qty: number
  unit: string
  store_label: string | null
}

type RecentPurchase = {
  name: string
  store_label: string | null
}

type PersonaSettings = {
  persona_enabled: number | null
  persona_user_role: string | null
  persona_ai_role: string | null
}

export type ChatContext = {
  persona: PersonaSettings | null
  lowStock: LowStockItem[]
  expiring: ExpiringItem[]
  activePlan: ActivePlanItem[]
  recentPurchases: RecentPurchase[]
}

export function buildChatSystemPrompt(ctx: ChatContext): string {
  const base = buildSystemPrompt(ctx.persona)
  const lowStockLines =
    ctx.lowStock
      .map(
        (s) =>
          `- ${s.name} (qty: ${s.qty}${s.unit ? ' ' + s.unit : ''}, runs out in ${s.run_out_days ?? '?'} days)`
      )
      .join('\n') || '- None'
  const expiringLines =
    ctx.expiring
      .map(
        (s) => `- ${s.name} (qty: ${s.qty}${s.unit ? ' ' + s.unit : ''}, expires: ${s.expiry_date})`
      )
      .join('\n') || '- None'
  const planLines =
    ctx.activePlan
      .map(
        (p) =>
          `- ${p.qty} ${p.unit} ${p.name}${p.store_label ? ' @ ' + p.store_label : ''} (pending)`
      )
      .join('\n') || '- No active plan'
  const purchaseLines =
    ctx.recentPurchases
      .map((p) => `- ${p.name}${p.store_label ? ' @ ' + p.store_label : ''}`)
      .join('\n') || '- None'

  return `${base}

You are helping with this household's inventory. Use ONLY the following household context. Never reveal data from another household.

Low-stock items (running out within 7 days):
${lowStockLines}

Expiring items (within 7 days):
${expiringLines}

Active shopping plan (not yet bought):
${planLines}

Recent purchases (last 30 days, regular buys):
${purchaseLines}

Answer the user's message. Be concise, practical, and grounded in the household's data above. Do not hallucinate items that aren't listed.`
}

export async function sendChatMessage(
  provider: string,
  apiKey: string,
  ctx: ChatContext,
  message: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  opts?: AiCallOpts
): Promise<string> {
  const systemPrompt = buildChatSystemPrompt(ctx)
  const conversation = history
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')
  const userPrompt = conversation ? `${conversation}\nUser: ${message}` : message
  return completeText(provider, apiKey, systemPrompt, userPrompt, opts)
}
