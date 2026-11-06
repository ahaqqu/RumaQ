import { describe, it, expect } from 'vite-plus/test'
import en from '../locales/en.json'
import id from '../locales/id.json'

function flattenKeys(obj, prefix = '') {
  return Object.entries(obj).reduce((acc, [key, val]) => {
    const k = prefix ? `${prefix}.${key}` : key
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      acc.push(...flattenKeys(val, k))
    } else {
      acc.push(k)
    }
    return acc
  }, [])
}

describe('locale files', () => {
  it('en.json is a valid object', () => {
    expect(typeof en).toBe('object')
    expect(en).not.toBeNull()
  })

  it('id.json is a valid object', () => {
    expect(typeof id).toBe('object')
    expect(id).not.toBeNull()
  })

  // Canonical product rename (#423, PR C). The parity tests above prove the
  // shape; these pin that the namespace actually exists in both files and that
  // the Indonesian copy is translated rather than an English copy-paste.
  describe('rename namespace (#423)', () => {
    // Values that are format-only (placeholders, digits, units of measure) or
    // identical in both languages by design.
    const LANGUAGE_NEUTRAL = new Set([
      'previewOldToNew',
      'duplicateConflict',
      'similarRow',
      'reasonCount',
      'aliasSourceOcr',
      'aliasSourceAdmin',
    ])

    it('exists in both locales with the same keys', () => {
      expect(en.rename).toBeDefined()
      expect(id.rename).toBeDefined()
      expect(Object.keys(id.rename).sort()).toEqual(Object.keys(en.rename).sort())
    })

    it('has real Indonesian copy, not English copies', () => {
      for (const [key, value] of Object.entries(en.rename)) {
        if (LANGUAGE_NEUTRAL.has(key)) continue
        expect(id.rename[key], `rename.${key} is untranslated`).not.toBe(value)
      }
    })

    it('pins the primary action copy', () => {
      expect(en.rename.action).toBe('Rename')
      expect(id.rename.action).toBe('Ganti nama')
      expect(en.rename.submit).toBe('Save new name')
      expect(id.rename.submit).toBe('Simpan nama baru')
      expect(en.rename.frozenPairNote).toContain('frozen catalog label')
      expect(id.rename.frozenPairNote).toContain('label katalognya')
    })
  })

  it('en and id have the same top-level keys', () => {
    const enKeys = Object.keys(en).sort()
    const idKeys = Object.keys(id).sort()
    expect(enKeys).toEqual(idKeys)
  })

  it('en and id have the same flattened key structure', () => {
    const enFlat = flattenKeys(en).sort()
    const idFlat = flattenKeys(id).sort()
    expect(enFlat).toEqual(idFlat)
  })

  it('en contains all required top-level namespaces', () => {
    const expected = [
      'nav',
      'home',
      'inventory',
      'addReceipt',
      'plan',
      'history',
      'settings',
      'assistant',
      'ui',
      'common',
      'data',
      'persona',
      'offline',
      'pwa',
    ]
    for (const ns of expected) {
      expect(en).toHaveProperty(ns)
    }
  })

  it('all string values are non-empty', () => {
    function checkStrings(obj, path = '') {
      for (const [key, val] of Object.entries(obj)) {
        const p = path ? `${path}.${key}` : key
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          checkStrings(val, p)
        } else if (typeof val === 'string') {
          expect(val.trim(), `${p} should not be empty`).not.toBe('')
        }
      }
    }
    checkStrings(en)
    checkStrings(id)
  })
})

describe('i18n initialisation', () => {
  it('can dynamically import and initialise i18n', async () => {
    const mod = await import('../index.js')
    expect(mod.i18n).toBeDefined()
    expect(mod.i18n.language).toBe('en')
  })

  it('switches language and updates html lang attribute', async () => {
    const mod = await import('../index.js')
    mod.i18n.changeLanguage('id')
    await new Promise((r) => setTimeout(r, 50))
    expect(document.documentElement.lang).toBe('id')
    mod.i18n.changeLanguage('en')
    await new Promise((r) => setTimeout(r, 50))
    expect(document.documentElement.lang).toBe('en')
  })

  it('saves language preference to localStorage', async () => {
    localStorage.removeItem('rumaq:lang')
    const mod = await import('../index.js')
    expect(mod.i18n.language).toBe('en')
    mod.i18n.changeLanguage('id')
    await new Promise((r) => setTimeout(r, 50))
    expect(localStorage.getItem('rumaq:lang')).toBe('id')
    mod.i18n.changeLanguage('en')
  })

  it('loadLang falls back to en when localStorage throws', async () => {
    const origGetItem = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('denied')
    }
    const mod = await import('../index.js')
    const lang = mod.loadLang()
    expect(lang).toBe('en')
    Storage.prototype.getItem = origGetItem
  })

  it('saveLang falls back silently when localStorage.setItem throws', async () => {
    const origSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('denied')
    }
    const mod = await import('../index.js')
    expect(() => mod.i18n.changeLanguage('id')).not.toThrow()
    Storage.prototype.setItem = origSetItem
  })
})
