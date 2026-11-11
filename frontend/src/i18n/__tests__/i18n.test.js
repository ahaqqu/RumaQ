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

  // Bulk exact-name alias approval (ahaqqu/RumaQ#515, follow-up to #489). The
  // duplicate-names section above proves the parity shape; this pins that the
  // panel's copy exists in both locales with real Indonesian, that the confirm
  // names the count, and that the safety framing (exact match only) is on the
  // screen next to the button.
  describe('aliasBulk namespace (#515)', () => {
    const BULK_KEYS = [
      'title',
      'desc',
      'candidateTotal',
      'exactTotal',
      'approve',
      'confirm_one',
      'confirm_other',
      'approving',
      'success_one',
      'success_other',
      'nothingToApprove',
      'indexVersion',
      'loading',
      'error',
      'retry',
      'approveError',
      'approveErrorPartial',
    ]

    it('exists in both locales with the same keys', () => {
      expect(en.aliasBulk).toBeDefined()
      expect(id.aliasBulk).toBeDefined()
      expect(Object.keys(id.aliasBulk).sort()).toEqual(Object.keys(en.aliasBulk).sort())
      for (const key of BULK_KEYS) {
        expect(en.aliasBulk[key], `aliasBulk.${key} missing in en`).toBeTypeOf('string')
        expect(id.aliasBulk[key], `aliasBulk.${key} missing in id`).toBeTypeOf('string')
      }
    })

    it('has real Indonesian copy, not English copies', () => {
      for (const [key, value] of Object.entries(en.aliasBulk)) {
        expect(id.aliasBulk[key], `aliasBulk.${key} is untranslated`).not.toBe(value)
      }
    })

    it('pins the safe-action framing and the counted confirm', () => {
      expect(en.aliasBulk.title).toBe('Alias candidates')
      expect(id.aliasBulk.title).toBe('Alias kandidat')
      expect(en.aliasBulk.approve).toBe('Approve exact matches')
      expect(id.aliasBulk.approve).toBe('Setujui yang cocok persis')
      // Only exact-name candidates are safe to bulk-approve: the copy says so,
      // and the confirm names the count it is about to move.
      expect(en.aliasBulk.desc).toContain('exactly matches')
      expect(id.aliasBulk.desc).toContain('persis sama')
      expect(en.aliasBulk.confirm_other).toContain('{{count}}')
      expect(id.aliasBulk.confirm_other).toContain('{{count}}')
      expect(en.aliasBulk.confirm_other).toContain('manual review')
      expect(id.aliasBulk.confirm_other).toContain('ditinjau manual')
      // A partial failure is reported with the count reached, never as a
      // silent success.
      expect(en.aliasBulk.approveErrorPartial).toContain('{{approved}}')
      expect(id.aliasBulk.approveErrorPartial).toContain('{{approved}}')
      expect(en.aliasBulk.indexVersion).toBe('Canonical index version')
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

  // Plural suffixes (#579): i18next v21+ resolves count keys through
  // Intl.PluralRules with the `_one`/`_other` family and IGNORES the legacy
  // v1 `_plural` suffix — a key carrying it silently renders the singular for
  // every count ("2 product"). No locale key may use a suffix the engine
  // drops, and the count keys must exist as `_one`/`_other` in both locales.
  describe('plural suffixes (#579)', () => {
    it('no key in either locale uses the legacy _plural suffix', () => {
      for (const [locale, tree] of [
        ['en', en],
        ['id', id],
      ]) {
        for (const key of flattenKeys(tree)) {
          expect(key.endsWith('_plural'), `${locale}: ${key} uses the ignored _plural suffix`).toBe(
            false
          )
        }
      }
    })

    it('the count keys exist as _one/_other in both locales', () => {
      for (const ns of ['prices']) {
        expect(en[ns].storesCount_one, 'en storesCount_one').toBeTypeOf('string')
        expect(en[ns].storesCount_other, 'en storesCount_other').toBeTypeOf('string')
        expect(en[ns].productsCount_one, 'en productsCount_one').toBeTypeOf('string')
        expect(en[ns].productsCount_other, 'en productsCount_other').toBeTypeOf('string')
        expect(Object.keys(id[ns]).sort()).toEqual(Object.keys(en[ns]).sort())
      }
    })
  })
})

describe('i18n initialisation', () => {
  it('can dynamically import and initialise i18n', async () => {
    const mod = await import('../index.js')
    expect(mod.i18n).toBeDefined()
    expect(mod.i18n.language).toBe('en')
  })

  // The engine-level pin for #579: the count keys resolve through the real
  // plural machinery, so a count of 2 renders the plural form — not the
  // singular every count got while the legacy `_plural` suffix was ignored.
  it('resolves plural counts through the engine (en)', async () => {
    const mod = await import('../index.js')
    mod.i18n.changeLanguage('en')
    expect(mod.i18n.t('prices.productsCount', { count: 2 })).toBe('2 products')
    expect(mod.i18n.t('prices.productsCount', { count: 1 })).toBe('1 product')
    expect(mod.i18n.t('prices.storesCount', { count: 2 })).toBe('2 stores')
    expect(mod.i18n.t('prices.storesCount', { count: 1 })).toBe('1 store')
  })

  it('resolves plural counts through the engine (id, single plural category)', async () => {
    const mod = await import('../index.js')
    mod.i18n.changeLanguage('id')
    expect(mod.i18n.t('prices.productsCount', { count: 2 })).toBe('2 produk')
    expect(mod.i18n.t('prices.productsCount', { count: 1 })).toBe('1 produk')
    expect(mod.i18n.t('prices.storesCount', { count: 2 })).toBe('2 toko')
    mod.i18n.changeLanguage('en')
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
