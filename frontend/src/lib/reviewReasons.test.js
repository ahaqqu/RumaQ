import { describe, it, expect } from 'vite-plus/test'
import openapi from '../../openapi.json'
import { REVIEW_REASONS } from './api'

// Issue #628 (B1): the review page's reason chips iterate REVIEW_REASONS, so
// the frontend's ONE runtime list must match the vocabulary the backend
// PUBLISHES in the committed spec — generated from `REVIEW_REASONS` in
// backend/src/lib/match-review.ts, with CI failing on client/spec drift. This
// is the frontend half of the single-source pin; the backend half is the spec
// test in backend/src/__tests__/match-review.test.ts. A fourth reason added on
// the backend therefore cannot leave the UI silently offering three chips.
describe('review reason vocabulary (issue #628)', () => {
  const operation = openapi.paths['/api/admin/review'].get
  const splitSchema =
    operation.responses['200'].content['application/json'].schema.properties.counts.properties
      .pendingByReason

  it('matches the reason query param enum', () => {
    const reasonParam = operation.parameters.find((parameter) => parameter.name === 'reason')
    expect(reasonParam).toBeDefined()
    expect(reasonParam.schema).toEqual({ type: 'string', enum: [...REVIEW_REASONS] })
  })

  it('matches the pendingByReason response keys', () => {
    expect(Object.keys(splitSchema.properties)).toEqual([...REVIEW_REASONS])
  })
})
