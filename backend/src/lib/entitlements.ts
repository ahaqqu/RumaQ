// Premium gating hooks (pipeline-split design §7.3, ahaqqu/RumaQ#376):
// plan → entitlement resolution for the price-data routes. Behavior-neutral
// tonight — every plan carries every entitlement, and user_plans has no
// writer yet (assignment is a future product ticket), so resolvePlan returns
// 'free' for everyone until rows exist. Responses and logs never name the
// plan; only an Entitlement names what was denied, and the denial is a bare
// 403.

import type { Env } from '../types.js'

export type Plan = 'free' | 'premium'

export type Entitlement =
  | 'prices.explore' // /api/prices listing + meta + promos + brochures
  | 'prices.history' // /api/prices/:productKey detail/history

export const PLAN_ENTITLEMENTS: Record<Plan, ReadonlySet<Entitlement>> = {
  // Everyone-free tonight (byte-neutral wiring): dropping an entitlement from
  // a plan is the future product ticket's lever, not a change to the wiring.
  free: new Set<Entitlement>(['prices.explore', 'prices.history']),
  premium: new Set<Entitlement>(['prices.explore', 'prices.history']),
}

/** Reads the user's plan from user_plans. A missing row, an absent table
 *  (pre-migration deploy), an unknown plan value, or any read failure
 *  resolves to 'free' — never throws. Fail-open is safe while 'free' carries
 *  every entitlement, and a transient D1 hiccup cannot lock a paying user
 *  out. */
export async function resolvePlan(env: Env['Bindings'], userId: string): Promise<Plan> {
  try {
    const row = await env.DB.prepare('SELECT plan FROM user_plans WHERE user_id = ?')
      .bind(userId)
      .first<{ plan: string }>()
    return row?.plan === 'premium' ? 'premium' : 'free'
  } catch {
    return 'free'
  }
}

export type EntitlementVerdict = { ok: true } | { ok: false; status: 403; error: string }

/** Guard for one entitlement: { ok: true } when the caller's plan carries it,
 *  otherwise { ok: false, status: 403, error } with a plan-agnostic message.
 *  Never throws. */
export async function requireEntitlement(
  env: Env['Bindings'],
  userId: string,
  entitlement: Entitlement
): Promise<EntitlementVerdict> {
  const plan = await resolvePlan(env, userId)
  if (PLAN_ENTITLEMENTS[plan].has(entitlement)) {
    return { ok: true }
  }
  return { ok: false, status: 403, error: 'Forbidden' }
}
