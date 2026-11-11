// Test-only react-i18next module for suites that must assert an interpolated
// display string instead of the raw key. The global mock (test-setup.js)
// returns keys so most assertions stay translation-independent; this one
// resolves the English template for the small allowlist below and keeps the
// same raw-key fallback everywhere else.
import { vi } from 'vite-plus/test'
import en from './i18n/locales/en.json'

const REAL_TEMPLATE_KEYS = new Set([
  // The per-unit line: the unit is normalized by prettyUnit, so "2pcs" vs
  // "2 pcs" is only observable through the rendered template (issue #636).
  'prices.perUnit',
])

function lookup(key) {
  return key.split('.').reduce((node, part) => (node == null ? node : node[part]), en)
}

function t(key, opts) {
  if (opts?.returnObjects) return {}
  if (!REAL_TEMPLATE_KEYS.has(key)) return opts?.defaultValue ?? key
  const template = lookup(key)
  if (typeof template !== 'string') return opts?.defaultValue ?? key
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? `{{${name}}}`))
}

export function mockReactI18next() {
  return {
    useTranslation: () => ({
      t,
      i18n: { language: 'en', changeLanguage: vi.fn(), on: vi.fn(), off: vi.fn() },
    }),
    I18nextProvider: ({ children }) => children,
    initReactI18next: { type: '3rdParty', init: vi.fn() },
  }
}
