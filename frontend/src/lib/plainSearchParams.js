// Plain query-string semantics for the TanStack router (wired in App.jsx).
// The library defaults JSON-round-trip search values: `?admin=true` parses
// to boolean true, `?date=20261118` to a number, and a resolved string that
// would parse back as JSON re-serializes quoted (`date=%2220261118%22`). On
// /brochures/view that broke the deep-link contract (#716) — the route's
// validateSearch must recompose the canonical brochure_url byte-exactly and
// the QA flag `?admin=true` must survive the load — and it silently dropped
// household invite links whose all-digit code parses as a number.
//
// Both halves mirror router-core's qss encode/decode (single value per key,
// undefined skipped, repeated keys collapse to an array, URLSearchParams
// charset) minus the value coercion, so parse and stringify stay symmetric.

/** Router parseSearch: every value is a string — no JSON/numeric coercion.
 * (URLSearchParams skips a single leading `?` itself.) */
export function plainParseSearch(searchStr) {
  const query = Object.create(null)
  for (const [key, value] of new URLSearchParams(searchStr)) {
    const previous = query[key]
    if (previous === undefined) query[key] = value
    else if (Array.isArray(previous)) previous.push(value)
    else query[key] = [previous, value]
  }
  return query
}

/** Router stringifySearch: URLSearchParams encoding, undefined dropped. */
export function plainStringifySearch(search) {
  const searchParams = new URLSearchParams()
  for (const key in search) {
    const value = search[key]
    if (value !== undefined) searchParams.set(key, String(value))
  }
  const searchStr = searchParams.toString()
  return searchStr ? `?${searchStr}` : ''
}
