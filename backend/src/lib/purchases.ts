// Purchase price semantics, Option B (issue #518, owner decisions 2026-11-10):
// purchase_items.price is the UNIT price — what the receipt's per-piece HARGA
// column shows (the receipt-scan prompt's rule). line_total is the line's
// payable amount: the receipt's printed line total when it shows one, else the
// server-computed qty × price. purchases.total is ALWAYS computed here on the
// server, at both INSERT paths (receipt + plan check-off), never trusted from
// the client: Σ COALESCE(line_total, price × qty).
//
// The COALESCE fallback exists for legacy rows written before the line_total
// column (#518 Q4 — no backfill): their line_total is NULL, so read-side
// aggregation falls back to price × qty. A NULL price (plan check-off with no
// estimate, #518 Q6) contributes nothing — never a 0-rupiah row.

export type PurchaseLine = {
  qty: number
  price: number | null
  line_total?: number | null
}

/** The line's payable amount: the printed total, else qty × unit price. */
export function lineTotalOf(line: PurchaseLine): number | null {
  if (line.line_total != null) return line.line_total
  if (line.price == null) return null
  return Math.round(line.price * line.qty)
}

/**
 * Server-computed grand total: Σ COALESCE(line_total, price × qty). NULL when
 * no line carries an amount (a check-off trip with no estimate) — unknown is
 * NULL, not 0.
 */
export function purchaseTotalOf(lines: PurchaseLine[]): number | null {
  let total: number | null = null
  for (const line of lines) {
    const amount = lineTotalOf(line)
    if (amount == null) continue
    total = (total ?? 0) + amount
  }
  return total
}
