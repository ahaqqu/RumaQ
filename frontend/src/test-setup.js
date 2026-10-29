import { vi, afterEach } from 'vite-plus/test'
import React from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup } from '@testing-library/react'

import en from './i18n/locales/en.json'

// Vitest runs with globals disabled, so @testing-library/react cannot
// self-register its automatic cleanup — without this, every rendered React
// tree stays mounted after the file's tests end. A still-mounted root lets
// stray updates (debounce timers, waitFor polling) commit after vitest has
// torn down the jsdom environment; React 19 flushes the resulting passive
// effects on a Node `setImmediate` (survives teardown) that reads the deleted
// `window.event` global — the nondeterministic "ReferenceError: window is not
// defined" unhandled error that fails CI on whichever file happens to be
// running (issue #317). Unmounting here flushes that work while `window`
// still exists.
afterEach(() => cleanup())

vi.mock('idb-keyval', () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@tanstack/react-query-persist-client', () => ({
  PersistQueryClientProvider: ({ client, children }) =>
    React.createElement(QueryClientProvider, { client }, children),
}))

vi.mock('react-i18next', () => {
  const t = (key, opts) => {
    if (opts && opts.returnObjects) return {}
    if (opts && opts.defaultValue) return opts.defaultValue
    if (key.startsWith('persona.mood.')) {
      const parts = key.split('.')
      const moodKey = parts[parts.length - 1]
      const template = en.persona?.mood?.[moodKey]
      if (template && opts) {
        return template.replace(/\{\{(\w+)\}\}/g, (_, name) => opts[name] ?? `{{${name}}}`)
      }
    }
    return key
  }
  return {
    useTranslation: () => ({
      t,
      i18n: {
        language: 'en',
        changeLanguage: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      },
    }),
    I18nextProvider: ({ children }) => children,
    initReactI18next: { type: '3rdParty', init: vi.fn() },
  }
})

const mockPersona = {
  persona: {
    enabled: false,
    userRole: '',
    aiRole: '',
    hue: 230,
    generatedCopy: null,
  },
  setPersona: vi.fn(),
  regenerateCopy: vi.fn(),
}

vi.mock('./context/PersonaContext.jsx', () => ({
  PersonaProvider: ({ children }) => children,
  usePersona: () => mockPersona,
}))

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router')
  return {
    ...actual,
    useMatches: () => [{ routeId: '/', pathname: '/' }],
    useNavigate: () => vi.fn(),
    Link: ({ children, to, className, ...props }) =>
      React.createElement('a', { ...props, className, href: to, 'data-testid': 'link' }, children),
    Outlet: () => null,
  }
})
