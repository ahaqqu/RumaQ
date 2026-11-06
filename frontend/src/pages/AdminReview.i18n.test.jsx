import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { AdminReview } from './AdminReview.jsx'
import id from '../i18n/locales/id.json'

// Real-copy pass for the review queue (issue #480): AdminReview.test.jsx runs
// on test-setup's raw-key t() (assertions read keys), so the approve/reject
// rubric could render as a literal key with nothing failing. This file
// resolves en.json and interpolates like i18next does (the Home.test.jsx /
// Documents.i18n.test.jsx idiom) and pins the REAL rendered sentences.
vi.mock('react-i18next', async () => {
  const { vi } = await import('vite-plus/test')
  const en = (await import('../i18n/locales/en.json')).default
  const lookup = (key) => key.split('.').reduce((node, k) => (node == null ? node : node[k]), en)
  const t = (key, opts) => {
    if (opts && opts.returnObjects) return {}
    let template
    if (opts && typeof opts.count === 'number') {
      template = lookup(`${key}_${opts.count === 1 ? 'one' : 'other'}`)
    }
    if (typeof template !== 'string') template = lookup(key)
    if (typeof template !== 'string') return opts?.defaultValue ?? key
    if (!opts) return template
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts[name] ?? `{{${name}}}`))
  }
  return {
    t,
    useTranslation: () => ({
      t,
      i18n: { language: 'en', changeLanguage: vi.fn(), on: vi.fn(), off: vi.fn() },
    }),
    I18nextProvider: ({ children }) => children,
    initReactI18next: { type: '3rdParty', init: vi.fn() },
  }
})

vi.mock('../lib/queries/me.js', () => ({ useMe: vi.fn() }))
vi.mock('../lib/queries/index.js', () => ({ usePriceSources: vi.fn() }))
vi.mock('../lib/queries/review.js', () => ({
  useReviewItems: vi.fn(),
  useDecideReview: vi.fn(),
  useUndoReview: vi.fn(),
}))
vi.mock('../lib/api', () => ({ fetchReviewExport: vi.fn() }))

import { useMe } from '../lib/queries/me.js'
import { usePriceSources } from '../lib/queries/index.js'
import { useReviewItems, useDecideReview, useUndoReview } from '../lib/queries/review.js'

const reviewItem = {
  id: '31b35444-4c2b-4b8e-9a4f-0d2c6e7f8a90',
  itemName: 'Beras Ramos 5 kg',
  itemBrand: null,
  itemUnit: '5 kg',
  itemPrice: 89000,
  itemStore: 'lotte-mart',
  entryName: 'Beras Ramos 5kg',
  entryBrand: 'Ramos',
  entryUnit: '5 kg',
  entryPrice: 27000,
  entryStore: 'superindo',
  matchMethod: 'exact',
  confidence: 1,
  reason: 'price_ratio',
  status: 'pending',
  flagCount: 2,
  lastFlaggedAt: '2026-10-28T23:00:05Z',
  runId: 'run-uuid-1',
}

const EN_RUBRIC =
  'Approve only when both sides are the same product — same brand, variant and size/pack. ' +
  'Price differences alone are fine to approve (promo, member vs non-member price). ' +
  'Reject when the size, variant, pack count or brand differs: they are different products.'

const EN_WHY_REVIEW =
  "Review is triggered by a flag — an implausible price gap against the catalog's last price, " +
  'or an unresolved AI verifier — not by the match confidence.'

const EN_CONFIDENCE_HINT =
  'How sure the matcher is that both sides are the same product — 100% means an exact name and ' +
  'unit match. Review is triggered by the flag, not by this score.'

const ID_RUBRIC =
  'Setujui hanya jika kedua sisi adalah produk yang sama — merek, varian, dan ukuran/kemasan sama. ' +
  'Selisih harga saja tetap boleh disetujui (promo, harga member vs non-member). Tolak jika ' +
  'ukuran, varian, jumlah kemasan, atau merek berbeda: itu produk yang berbeda.'

const ID_WHY_REVIEW =
  'Tinjauan dipicu oleh penanda — selisih harga yang tidak wajar terhadap harga terakhir ' +
  'katalog, atau verifier AI yang tidak tuntas — bukan oleh keyakinan cocok.'

const ID_CONFIDENCE_HINT =
  'Seberapa yakin matcher bahwa kedua sisi adalah produk yang sama — 100% berarti nama dan unit ' +
  'cocok persis. Tinjauan dipicu oleh penanda, bukan oleh skor ini.'

function reviewData(items = [reviewItem]) {
  return {
    data: {
      items,
      counts: { pending: items.length, approved: 0, rejected: 0 },
      filteredTotal: items.length,
    },
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
    isLoading: false,
    isError: false,
  }
}

function renderAdmin() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      React.createElement(AdminReview, null)
    )
  )
}

describe('AdminReview — initialized i18n copy (issue #480)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: true } } })
    vi.mocked(usePriceSources).mockReturnValue({
      data: [
        { slug: 'lotte-mart', name: 'Lotte Mart' },
        { slug: 'superindo', name: 'Superindo' },
      ],
    })
    vi.mocked(useReviewItems).mockReturnValue(reviewData())
    vi.mocked(useDecideReview).mockReturnValue({ mutate: vi.fn(), isPending: false })
    vi.mocked(useUndoReview).mockReturnValue({ mutate: vi.fn(), isPending: false })
  })

  it('renders the approve/reject rubric next to the record-only note', () => {
    const { container } = renderAdmin()
    expect(container.textContent).toContain(EN_RUBRIC)
    expect(container.textContent).toContain(
      'Decisions are recorded for future matcher improvements; they do not change current price data.'
    )
  })

  it('says review is flag-driven and names the confidence chip', () => {
    const { container } = renderAdmin()
    expect(container.textContent).toContain(EN_WHY_REVIEW)
    expect(container.textContent).toContain('Match confidence 100%')
    expect(container.textContent).toContain('Review flag: Price ratio')
    const confidence = [...container.querySelectorAll('[title]')].find(
      (el) => el.getAttribute('title') === EN_CONFIDENCE_HINT
    )
    expect(confidence).not.toBeUndefined()
  })

  it('renders the side labels once, in real EN', () => {
    const { container } = renderAdmin()
    expect(container.textContent.match(/Matched item/g)).toHaveLength(1)
    expect(container.textContent.match(/Catalog entry \(last seen\)/g)).toHaveLength(1)
  })

  it('renders the EN no-brand-unit line and no "— · —" when both values are missing', () => {
    vi.mocked(useReviewItems).mockReturnValue(
      reviewData([
        { ...reviewItem, itemBrand: null, itemUnit: null, entryBrand: null, entryUnit: null },
      ])
    )
    const { container } = renderAdmin()
    expect(container.textContent).toContain('No brand or unit recorded')
    expect(container.textContent).not.toContain('— · —')
  })

  it('carries the Indonesian rubric, why-review line, and fallback copy', () => {
    expect(id.review.decisionRubric).toBe(ID_RUBRIC)
    expect(id.review.noBrandUnit).toBe('Merek atau unit tidak tercatat')
    expect(id.review.copyItemId).toBe('Salin id item')
    expect(id.review.whyReview).toBe(ID_WHY_REVIEW)
    expect(id.review.confidence).toBe('Keyakinan cocok')
    expect(id.review.confidenceHint).toBe(ID_CONFIDENCE_HINT)
    expect(id.review.flagPrefix).toBe('Penanda tinjauan:')
  })
})
