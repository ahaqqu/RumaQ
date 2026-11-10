import { describe, it, expect } from 'vite-plus/test'
import { formatHouseholdMoney } from './household-money.js'
import { i18n } from '../i18n/index.js'

// #597: the household money formatter is household-scoped — id-ID always,
// never the viewer's UI language. The regression this pins is History's old
// i18n switch ("IDR 65,000" for en users) against Plan's fixed id-ID
// ("Rp 56.000"): the same amount must render as one string on every page.
describe('formatHouseholdMoney', () => {
  it.each(['id', 'en'])('formats id-ID regardless of the UI language (%s)', (lang) => {
    const orig = i18n.language
    i18n.language = lang
    try {
      // Intl id-ID puts a no-break space after Rp and dots the thousands.
      expect(formatHouseholdMoney(18500)).toBe('Rp\u00A018.500')
    } finally {
      i18n.language = orig
    }
  })

  it('renders zero without fabricating decimals', () => {
    expect(formatHouseholdMoney(0)).toBe('Rp\u00A00')
  })

  it('honors the household currency override (Plan passes settings.currency)', () => {
    expect(formatHouseholdMoney(1000, 'USD')).toContain('US$')
  })
})
