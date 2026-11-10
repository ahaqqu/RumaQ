// The wire bounds for the two factors every persisted money amount is built
// from (#586, R587-A1): a per-unit price × a quantity. Both purchase INSERT
// paths — a receipt line (POST /api/purchases) and a check-off line (PATCH
// plan item → bought; the saved plan's qty × price_estimate becomes the
// purchase's line amount) — multiply the same two shapes, so the same two
// bounds apply everywhere. The describeRoute mirrors in apps/api.ts import
// these constants too (R587-B1): the OpenAPI maximums ARE the validators', by
// construction, not hand-copied literals that can drift.
//
// QTY_MAX: a million units — far above any real receipt line.
// MONEY_MAX: a trillion rupiah — the per-LINE amount bound. The explicit
// line_total and the computed fallback (price × qty, checked cross-field in
// both wire schemas) both obey it: no persisted line amount above MONEY_MAX,
// whichever path produced it.
export const QTY_MAX = 1_000_000
export const MONEY_MAX = 1_000_000_000_000
