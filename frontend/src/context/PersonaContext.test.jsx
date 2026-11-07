import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

// The persona rewrite's last browser-side piece (#523 P5): the context is the
// only thing between Settings and the API client. test-setup mocks the context
// globally for every page test, so this file takes the ACTUAL module and drives
// the real provider — `regenerateCopy` must hand the server's answer to
// `setPersona` (which persists it) and must not swallow a failure.
vi.mock('../lib/persona.js', () => ({
  loadPersona: vi.fn(),
  savePersona: vi.fn(),
  deriveHue: vi.fn(() => 230),
  applyTheme: vi.fn(),
  generatePersonaCopy: vi.fn(),
}))

import { loadPersona, savePersona, generatePersonaCopy } from '../lib/persona.js'

const { PersonaProvider, usePersona } = await vi.importActual('./PersonaContext.jsx')

const DRAFT = { enabled: true, userRole: 'raja', aiRole: 'prajurit' }

function Probe() {
  const { persona, regenerateCopy } = usePersona()
  return React.createElement(
    'div',
    null,
    React.createElement(
      'span',
      { 'data-testid': 'copy' },
      persona.generatedCopy?.homeLead ?? 'none'
    ),
    React.createElement(
      'button',
      { onClick: () => regenerateCopy(DRAFT).catch(() => {}) },
      'regenerate'
    )
  )
}

function renderProvider() {
  // The rewrite is a react-query mutation (#523 P5): `regenerateCopy` goes
  // through useGeneratePersonaCopy so the day's usage meter is invalidated.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(PersonaProvider, null, React.createElement(Probe))
    )
  )
}

beforeEach(() => {
  loadPersona.mockReturnValue({ ...DRAFT, hue: 230, generatedCopy: null })
  savePersona.mockReset()
  generatePersonaCopy.mockReset()
})

describe('PersonaContext.regenerateCopy (#523 P5)', () => {
  it('stores the server rewrite through setPersona (which persists it)', async () => {
    generatePersonaCopy.mockResolvedValue({ homeLead: 'Sire, the kitchen is calm.' })
    const { getByText, getByTestId } = renderProvider()

    fireEvent.click(getByText('regenerate'))

    await waitFor(() => expect(getByTestId('copy').textContent).toBe('Sire, the kitchen is calm.'))
    // The draft the user is applying is what gets rewritten — not a stale state.
    expect(generatePersonaCopy).toHaveBeenCalledWith(DRAFT)
    expect(savePersona).toHaveBeenCalledWith(
      expect.objectContaining({ generatedCopy: { homeLead: 'Sire, the kitchen is calm.' } })
    )
  })

  it('leaves the built-in copy in place when the rewrite is refused (402)', async () => {
    generatePersonaCopy.mockRejectedValue(
      Object.assign(new Error('AI provider not configured.'), { status: 402 })
    )
    const { getByText, getByTestId } = renderProvider()

    fireEvent.click(getByText('regenerate'))

    await waitFor(() => expect(generatePersonaCopy).toHaveBeenCalled())
    expect(getByTestId('copy').textContent).toBe('none')
    // No generatedCopy is persisted: the UI keeps its own strings.
    expect(savePersona).not.toHaveBeenCalled()
  })
})
