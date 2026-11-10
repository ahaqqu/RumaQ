// Shared items-row resolution for the two line-item write paths (#551e, the
// R550-B1 extraction): the purchase loop and plan-save carried this block
// verbatim-duplicated — same normalizeItemName key (#526), same household-
// scoped LOWER(name) lookup, same INSERT shape (display name = the line's
// trim, first line's unit wins). One helper now owns it, so a name dedupes to
// the same items row whichever feature saved it, and the next divergence
// cannot drift in silently.
//
// The map and the statements array belong to the CALLER's batch: the SELECT
// cannot see INSERTs the same receipt/plan already pushed (the batch runs
// after the loop), so `seenByName` carries the in-flight resolution across
// lines. Explicit item_id lines are NOT handled here — the purchase loop's
// ownership check (#517) is security code that answers 404 and aborts the
// batch, which this helper cannot do.
import { normalizeItemName } from './plans.js'

export async function resolveOrCreateItemId(opts: {
  db: D1Database
  householdId: string
  name: string
  unit: string
  statements: D1PreparedStatement[]
  seenByName: Map<string, string>
}): Promise<string> {
  const normalizedName = normalizeItemName(opts.name)
  const seenItemId = opts.seenByName.get(normalizedName)

  if (seenItemId) {
    return seenItemId
  }

  const existing = await opts.db
    .prepare('SELECT id FROM items WHERE household_id = ? AND LOWER(name) = LOWER(?)')
    .bind(opts.householdId, normalizedName)
    .first<{ id: string }>()

  let itemId: string
  if (existing) {
    itemId = existing.id
  } else {
    itemId = crypto.randomUUID()
    opts.statements.push(
      opts.db
        .prepare('INSERT INTO items (id, household_id, name, default_unit) VALUES (?, ?, ?, ?)')
        .bind(itemId, opts.householdId, opts.name.trim(), opts.unit)
    )
  }
  opts.seenByName.set(normalizedName, itemId)
  return itemId
}
