// The shared JSON reader for every structured AI answer (plan §2.5, §5.4).
// Providers fence their JSON, wrap it in prose, or both; the ONE extraction
// policy lives here and each caller applies its own strict field validation on
// top. Moved out of lib/ai.ts in P2 so the legacy shim and the door's decision
// path read answers the same way.

export function parseJsonResponse<T>(content: string): T {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('AI response did not contain valid JSON')
  }

  try {
    return JSON.parse(jsonMatch[0]) as T
  } catch {
    throw new Error('Failed to parse AI response JSON')
  }
}
