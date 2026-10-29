import { describe, it, expect } from 'vite-plus/test'
import { render } from '@testing-library/react'
import React from 'react'

// Regression guard for issue #317. Vitest runs with globals disabled, so
// @testing-library/react's automatic cleanup does not self-register —
// src/test-setup.js wires `afterEach(cleanup)` explicitly. If that wiring is
// removed, rendered React trees stay mounted at file end: stray updates then
// commit after the jsdom environment is torn down, and React 19's deferred
// passive-effects flush runs on a Node `setImmediate` (which survives
// teardown) reading the deleted `window.event` global — the nondeterministic
// "ReferenceError: window is not defined" unhandled error that fails CI on
// whichever file is running. This test fails deterministically if the
// cleanup wiring disappears: whatever test 1 mounts must be gone by test 2.
describe('test setup wiring (issue #317)', () => {
  it('mounts a React tree that must not outlive this test', () => {
    const { container } = render(React.createElement('div', null, 'cleanup-probe'))
    expect(container.textContent).toBe('cleanup-probe')
  })

  it('finds no mounted React trees left by the previous test', () => {
    expect(document.body.children).toHaveLength(0)
  })
})
