// The internal ingest channel the e2e suites seed fixtures through (#677):
// the same POST endpoints the scraper uses, authenticated by the shared test
// secret (the test stack's compose env carries the matching
// HAQITA_INGEST_SECRET). One definition lives here — no steps file carries a
// local BASE_URL/INGEST_SECRET fixture push anymore.

export const TEST_BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'
export const INGEST_SECRET = 'test-ingest-secret'

async function ingestJson(path, body, failureLabel) {
  const res = await fetch(`${TEST_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INGEST_SECRET}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${failureLabel}: ${res.status} ${await res.text()}`)
  }
}

// Push a schema-v2 price snapshot. Failure semantics are the ones every
// former per-file copy had: throw on a non-2xx with the same message (the
// optional label lets a scenario-specific seeder keep its own wording).
export async function pushPriceSnapshot(payload, failureLabel = 'price snapshot push failed') {
  await ingestJson('/api/internal/ingest/prices', payload, failureLabel)
}

// Push a scraper run report. Returns the Response instead of throwing: the
// two callers check the status differently (admin-rename throws its own
// message, admin-review asserts with expect), and that split is behavior to
// preserve.
export async function pushRunReport(report) {
  return fetch(`${TEST_BASE_URL}/api/internal/ingest/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INGEST_SECRET}`,
    },
    body: JSON.stringify(report),
  })
}
