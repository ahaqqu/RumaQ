import { describe, it, expect } from 'vite-plus/test'
import { ApiError } from './api'
import { errorKindKey } from './errorKind.js'

// Audit 2026-11-16 L5: one i18n key per error kind, fed by M1's classifier.
describe('errorKindKey', () => {
  it('maps an offline ApiError to error.offline', () => {
    expect(
      errorKindKey(new ApiError('Network request failed', 0, null, undefined, 'offline'))
    ).toBe('error.offline')
  })

  it('maps a timeout ApiError to error.timeout', () => {
    expect(errorKindKey(new ApiError('Request timed out', 0, null, undefined, 'timeout'))).toBe(
      'error.timeout'
    )
  })

  it('maps an HTTP failure to error.http', () => {
    expect(errorKindKey(new ApiError('Server error', 500))).toBe('error.http')
  })

  it('maps an unknown throw to error.http, never offline', () => {
    expect(errorKindKey(new Error('mystery'))).toBe('error.http')
    expect(errorKindKey('a string')).toBe('error.http')
  })
})
