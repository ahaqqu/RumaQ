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

  // Candidate-alias decisions (ahaqqu/RumaQ#489, frontend PR 2). The rename
  // namespace parity above proves key equality; this pins that the decision
  // copy exists in BOTH locales with real Indonesian and the exact rendered
  // sentences (the approve/reject verbs, the index-version receipt, and the
  // CAS-loss notice).
  describe('alias decisions (#489)', () => {
    const DECISION_KEYS = [
      'aliasDecisionHint',
      'aliasApprove',
      'aliasReject',
      'aliasApproveLabel',
      'aliasRejectLabel',
      'aliasApproving',
      'aliasRejecting',
      // Reject's inline two-step confirm (#496).
      'aliasRejectConfirm',
      'aliasRejectConfirmLabel',
      'aliasRejectCancelLabel',
      'aliasRejectArmed',
      'aliasApproveSuccess',
      'aliasRejectSuccess',
      'aliasAlreadyDecided',
      'aliasErrorNotFound',
      'aliasErrorForbidden',
      'aliasErrorGeneric',
    ]

    it('exists in both locales with the same decision keys', () => {
      for (const key of DECISION_KEYS) {
        expect(en.rename[key], `rename.${key} missing in en`).toBeTypeOf('string')
        expect(id.rename[key], `rename.${key} missing in id`).toBeTypeOf('string')
      }
    })

    it('has real Indonesian copy, not English copies', () => {
      for (const key of DECISION_KEYS) {
        expect(id.rename[key], `rename.${key} is untranslated`).not.toBe(en.rename[key])
      }
    })

    it('pins the actions, the receipts and the conflict notice', () => {
      expect(en.rename.aliasApprove).toBe('Approve')
      expect(id.rename.aliasApprove).toBe('Setujui')
      expect(en.rename.aliasReject).toBe('Reject')
      expect(id.rename.aliasReject).toBe('Tolak')
      expect(en.rename.aliasApproving).toBe('Approving…')
      // #496: rejecting asks twice, so its prompt, its per-row labels and the
      // spoken warning exist in both languages and say the decision is final.
      expect(en.rename.aliasRejectConfirm).toBe('Confirm reject?')
      expect(id.rename.aliasRejectConfirm).toBe('Konfirmasi penolakan?')
      expect(en.rename.aliasRejectConfirmLabel).toBe('Confirm rejecting {{name}}')
      expect(id.rename.aliasRejectConfirmLabel).toBe('Konfirmasi penolakan {{name}}')
      expect(en.rename.aliasRejectCancelLabel).toBe('Cancel rejecting {{name}}')
      expect(id.rename.aliasRejectCancelLabel).toBe('Batalkan penolakan {{name}}')
      expect(en.rename.aliasRejectArmed).toContain('A rejection is final.')
      expect(en.rename.aliasRejectArmed).toContain('{{name}}')
      expect(id.rename.aliasRejectArmed).toContain('Penolakan bersifat final.')
      // Approve stays a single click: it has no confirm copy at all.
      expect(en.rename.aliasApproveConfirm).toBeUndefined()
      // Approve is the only decision that moves the index: its receipt names
      // the new version, reject's says the version is unchanged.
      expect(en.rename.aliasApproveSuccess).toContain('version {{version}}')
      expect(en.rename.aliasApproveSuccess).toContain('{{name}}')
      expect(en.rename.aliasRejectSuccess).toContain('stays at version {{version}}')
      expect(en.rename.aliasAlreadyDecided).toBe(
        'This alias was already decided ({{status}}) — the list has been refreshed.'
      )
      expect(id.rename.aliasAlreadyDecided).toContain('sudah diputuskan')
      expect(id.rename.aliasAlreadyDecided).toContain('{{status}}')
      expect(en.rename.aliasErrorForbidden).toBe('Only admins can decide aliases.')
      // The decision is terminal in the backend (candidate-only CAS, no reset
      // path), so the hint must say so instead of reading like a toggle.
      expect(en.rename.aliasDecisionHint).toContain('A decision is final.')
      expect(id.rename.aliasDecisionHint).toContain('Keputusan bersifat final.')
    })
  })

  // AI review UI (issue #484, frontend PR 2). The global parity tests above
  // prove the shape; these pin that the new AI copy exists in BOTH locales
  // with real Indonesian (not an English copy-paste) and that the rendered
  // chip/banner copy is the intended text.
  describe('review AI namespace (#484)', () => {
    // Format-only strings: identical in both languages by design (the "AI"
    // label, placeholders, and the confidence/verdict template).
    const LANGUAGE_NEUTRAL = new Set(['aiVerdict', 'aiModel', 'aiModeLegend'])

    function aiKeys(locale) {
      return Object.keys(locale.review)
        .filter((key) => key.startsWith('ai'))
        .sort()
    }

    it('exists in both locales with the same ai* keys', () => {
      expect(aiKeys(en)).toEqual(aiKeys(id))
      expect(aiKeys(en)).toContain('aiModeManual')
      expect(aiKeys(en)).toContain('aiModeAssist')
      expect(aiKeys(en)).toContain('aiModeAuto')
      expect(aiKeys(en)).toContain('aiNotConfigured')
      expect(aiKeys(en)).toContain('aiVerdict')
      expect(aiKeys(en)).toContain('aiAgree')
      expect(aiKeys(en)).toContain('aiDisagree')
      expect(aiKeys(en)).toContain('aiEvaluateMore')
      expect(aiKeys(en)).toContain('aiWaiting')
      expect(aiKeys(en)).toContain('aiProvenanceHuman')
      expect(aiKeys(en)).toContain('aiProvenanceAssist')
      expect(aiKeys(en)).toContain('aiProvenanceAuto')
    })

    it('has real Indonesian copy, not English copies', () => {
      for (const key of aiKeys(en)) {
        if (LANGUAGE_NEUTRAL.has(key)) continue
        expect(id.review[key], `review.${key} is untranslated`).not.toBe(en.review[key])
      }
    })

    it('pins the mode labels and the default explanation', () => {
      expect(en.review.aiModeManual).toBe('Manual review')
      expect(en.review.aiModeAssist).toBe('Automate review with approval')
      expect(en.review.aiModeAuto).toBe('Full automate review')
      expect(en.review.aiModeAssistDesc).toContain('proposes a verdict')
      expect(id.review.aiModeManual).toBe('Tinjauan manual')
      expect(id.review.aiModeAssist).toBe('Otomatiskan tinjauan dengan persetujuan')
      expect(id.review.aiModeAuto).toBe('Otomatiskan tinjauan sepenuhnya')
    })

    it('pins the verdict chip, banner, and provenance copy', () => {
      expect(en.review.aiVerdict).toBe('AI: {{verdict}} · {{confidence}}%')
      expect(en.review.aiSame).toBe('same')
      expect(en.review.aiDifferent).toBe('different')
      expect(en.review.aiNotConfigured).toContain('AI is not configured')
      expect(en.review.aiProvenanceHuman).toBe('Decided by human')
      expect(en.review.aiProvenanceAuto).toBe('Applied by AI · full auto')
      expect(en.review.aiAutoCronNote).toBe('AI evaluates automatically every 30 minutes.')
    })
  })

  // Read-only duplicate-name report (ahaqqu/RumaQ#485). The parity tests below
  // prove the shape; these pin that the panel's copy exists in both locales
  // with real Indonesian and that it keeps saying "read-only".
  describe('duplicates namespace (#485)', () => {
    // Every string differs between the locales — including the plural forms and
    // the date template — so there is nothing to exclude from the guard below.
    const LANGUAGE_NEUTRAL = new Set()

    it('exists in both locales with the same keys', () => {
      expect(en.duplicates).toBeDefined()
      expect(id.duplicates).toBeDefined()
      expect(Object.keys(id.duplicates).sort()).toEqual(Object.keys(en.duplicates).sort())
    })

    it('has real Indonesian copy, not English copies', () => {
      for (const [key, value] of Object.entries(en.duplicates)) {
        if (LANGUAGE_NEUTRAL.has(key)) continue
        expect(id.duplicates[key], `duplicates.${key} is untranslated`).not.toBe(value)
      }
    })

    it('pins the read-only framing and the empty state', () => {
      expect(en.duplicates.title).toBe('Duplicate names')
      expect(id.duplicates.title).toBe('Nama duplikat')
      expect(en.duplicates.desc).toContain('Read-only')
      expect(id.duplicates.desc).toContain('Hanya baca')
      expect(en.duplicates.empty).toBe('No duplicate names.')
      expect(id.duplicates.empty).toBe('Tidak ada nama duplikat.')
      // The notice is cause-neutral: `truncated` covers the group, per-group,
      // and 900-row caps, so it must not claim the group list was cut.
      expect(en.duplicates.truncated).toContain('not complete')
      expect(id.duplicates.truncated).toContain('belum lengkap')
      expect(en.duplicates.truncated).not.toContain('{{limit}}')
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
