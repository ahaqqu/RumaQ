const MAX_PATTERN_ITEMS = 20

export type PurchasePattern = {
  item_id: string
  name: string
  avg_interval_days: number | null
  avg_qty: number
  last_purchase_date: string | null
  pattern: string
  purchase_count: number
}

export async function computePatterns(
  householdId: string,
  db: D1Database
): Promise<PurchasePattern[]> {
  // #548 (security, R547-A1): a poisoned purchase line (this household's row
  // pointing at another household's item) must not surface the foreign name as
  // a pattern. ON-clause placement de-references it: the line still aggregates
  // and its name falls back to 'Unknown' — a WHERE-clause predicate would drop
  // the line instead.
  const rows = await db
    .prepare(
      `SELECT pi.item_id,
              i.name        AS item_name,
              pi.qty,
              p.date
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       LEFT JOIN items i ON i.id = pi.item_id AND i.household_id = ?
       WHERE p.household_id = ?
       ORDER BY p.date DESC
       LIMIT 1000`
    )
    .bind(householdId, householdId)
    .all<{
      item_id: string
      item_name: string | null
      qty: number
      date: string
    }>()

  if (!rows.results || rows.results.length === 0) return []

  const byItem = new Map<string, { name: string; dates: number[]; qtySum: number; count: number }>()
  for (const r of rows.results) {
    if (!r.item_id) continue
    const entry = byItem.get(r.item_id) ?? {
      name: r.item_name ?? 'Unknown',
      dates: [],
      qtySum: 0,
      count: 0,
    }
    entry.dates.push(new Date(r.date).getTime())
    entry.qtySum += r.qty
    entry.count += 1
    byItem.set(r.item_id, entry)
  }

  const patterns: PurchasePattern[] = []
  for (const [item_id, entry] of byItem) {
    const sortedDates = entry.dates.sort((a, b) => a - b)
    let intervals = 0
    let intervalSum = 0
    for (let i = 1; i < sortedDates.length; i++) {
      const gap = (sortedDates[i] - sortedDates[i - 1]) / 86400000
      if (gap > 0) {
        intervalSum += gap
        intervals += 1
      }
    }
    const avgInterval = intervals > 0 ? Math.round(intervalSum / intervals) : null
    const avgQty = entry.count > 0 ? round1(entry.qtySum / entry.count) : 0
    const lastDate = sortedDates[sortedDates.length - 1]
    patterns.push({
      item_id,
      name: entry.name,
      avg_interval_days: avgInterval,
      avg_qty: avgQty,
      last_purchase_date: lastDate ? new Date(lastDate).toISOString().slice(0, 10) : null,
      pattern:
        avgInterval != null
          ? `every ${avgInterval} day${avgInterval === 1 ? '' : 's'}`
          : 'recently purchased',
      purchase_count: entry.count,
    })
  }

  patterns.sort((a, b) => b.purchase_count - a.purchase_count)
  return patterns.slice(0, MAX_PATTERN_ITEMS)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
