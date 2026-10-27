// Shared SQL helper used by both the API routes and the grounding lib.

// Escapes SQL LIKE wildcards so user input cannot widen a LIKE pattern.
// Pair with `ESCAPE '\\'` in the query.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
