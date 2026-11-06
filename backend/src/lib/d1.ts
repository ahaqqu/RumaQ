// Shared D1 batching helpers.
//
// A db.batch() call counts as ONE query against D1's per-invocation budget
// (50 on the free plan); within it, the per-query limits (100 bound
// parameters) apply to each statement — a v2 observation binds 24 (the raw
// provenance added five). 50 statements per batch keeps both limits
// comfortable.
export const BATCH_CHUNK = 50
// D1 also caps bound parameters per QUERY at 100 — an IN list must ride
// under that ceiling, or a catalog of ≥100 products fails the whole ingest
// with "too many SQL variables at offset …" (observed on the first 382-item
// live publish). 90 leaves headroom for any fixed parameters a caller adds
// (the calendar's household_id rides as one leading bind).
export const SELECT_IN_CHUNK = 90

// The budget those constants defend, stated once so a write path can refuse a
// payload it cannot fit instead of discovering it mid-flight. D1 stops the
// invocation on the query past this one, and a chunked write has no rollback
// across chunks: the earlier ones are committed and the last statement — the
// canonical-index bump — never runs, leaving content newer than the version it
// ships under. lib/ingest-v2.ts therefore checks the count before its write.
export const D1_QUERY_BUDGET = 50

export class D1QueryBudgetExceededError extends Error {
  constructor(readonly queries: number) {
    super(
      `Ingest needs ${queries} D1 queries, over the ${D1_QUERY_BUDGET}-query per-invocation budget: split the publish`
    )
    this.name = 'D1QueryBudgetExceededError'
  }
}

export function assertQueryBudget(queries: number): void {
  if (queries > D1_QUERY_BUDGET) throw new D1QueryBudgetExceededError(queries)
}

export type Statement = ReturnType<D1Database['prepare']>

export async function runBatch(db: D1Database, statements: Statement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK))
  }
}

/** Runs `sql` with an IN-list appended, one chunked pass per SELECT_IN_CHUNK
 * values. `leadingBinds` ride BEFORE the chunk's placeholders (a scoping
 * predicate like `WHERE household_id = ?`), keeping every query under D1's
 * 100-bound-parameter ceiling. */
export async function selectIn<Row>(
  db: D1Database,
  sql: string,
  values: string[],
  leadingBinds: string[] = []
): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < values.length; i += SELECT_IN_CHUNK) {
    const chunk = values.slice(i, i + SELECT_IN_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db
      .prepare(`${sql} (${placeholders})`)
      .bind(...leadingBinds, ...chunk)
      .all<Row>()
    rows.push(...(results ?? []))
  }
  return rows
}
