import { describe, it, expect } from 'vite-plus/test'
import { render } from '@testing-library/react'
import React from 'react'
import { AppProvider, useApp } from './AppContext.jsx'

// L7 (audit 2026-11-16): the plaintext browser AI key is retired — nothing
// reads it, so the provider name must not sit in JS-readable storage. The
// provider purges what older builds left behind on boot.
describe('AppContext', () => {
  it('purges the retired plaintext rumaq_ai_key from localStorage on mount', () => {
    localStorage.setItem('rumaq_ai_key', 'sk-stale-from-old-build')
    render(React.createElement(AppProvider, null, React.createElement('div')))
    expect(localStorage.getItem('rumaq_ai_key')).toBeNull()
  })

  it('survives storage being disabled', () => {
    const original = Storage.prototype.removeItem
    Storage.prototype.removeItem = () => {
      throw new Error('denied')
    }
    try {
      expect(() =>
        render(React.createElement(AppProvider, null, React.createElement('div')))
      ).not.toThrow()
    } finally {
      Storage.prototype.removeItem = original
    }
  })

  it('no longer exposes aiKey or setAiKey in the context', () => {
    let captured
    function Consumer() {
      captured = useApp()
      return null
    }
    render(React.createElement(AppProvider, null, React.createElement(Consumer, null)))
    expect('aiKey' in captured).toBe(false)
    expect('setAiKey' in captured).toBe(false)
    // The rest of the context the shell consumes is intact.
    expect(captured.setMotion).toBeTypeOf('function')
    expect(captured.setAssistantOpen).toBeTypeOf('function')
  })
})
