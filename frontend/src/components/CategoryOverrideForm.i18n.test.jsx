import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test'
import { render, fireEvent, act, screen } from '@testing-library/react'
import React from 'react'
import { CategoryOverrideForm } from './CategoryOverrideForm.jsx'
import { CategoryRevertBlock } from './CategoryRevertBlock.jsx'
import { ApiError } from '../lib/api'

// Real-copy pass for the category override (ahaqqu/RumaQ#728). The state
// machine tests run on test-setup's raw-key t() (assertions read keys), so a
// missing or malformed string could render as a literal key with nothing
// failing. This file resolves en.json and interpolates like i18next does (the
// ProductRenameForm.i18n.test.jsx idiom) and pins the REAL rendered sentences.
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

vi.mock('../lib/queries/products.js', () => ({
  useProductIdentity: vi.fn(),
  useRevertProductCategory: vi.fn(),
}))
vi.mock('../lib/queries/review.js', () => ({
  useTaxonomyBuckets: vi.fn(),
  useSetReviewCategory: vi.fn(),
}))

import { useProductIdentity, useRevertProductCategory } from '../lib/queries/products.js'
import { useTaxonomyBuckets, useSetReviewCategory } from '../lib/queries/review.js'

const PRODUCT_KEY = 'beras-ramos-5kg--ramos--5-kg'
const BUCKETS = ['sayuran', 'beras', 'buah', 'snack', 'minyak-goreng', 'lainnya']

const identity = {
  product: {
    id: 'product-1',
    productKey: PRODUCT_KEY,
    name: 'Beras Ramos 5kg',
    brand: 'Ramos',
    unit: '5 kg',
    status: 'provisional',
    category: 'snack',
    categoryVersion: 'v0.3',
    categorySource: null,
    metadataVersion: 3,
    updatedAt: '2026-11-18T06:00:00.000Z',
  },
  aliases: [],
  stats: { observations: 4, stores: 2 },
  audit: [],
  categoryAudit: [],
}

const saveMutate = vi.fn()
const revertMutate = vi.fn()

function renderForm(props = {}) {
  return render(
    <CategoryOverrideForm
      reviewItemId="rev-1"
      productKey={PRODUCT_KEY}
      assignedCategory="snack"
      rulesCategory="beras"
      isAdmin
      {...props}
    />
  )
}

function pickAndSubmit(container) {
  fireEvent.click(container.querySelector('[data-testid="category-picker"] > button'))
  fireEvent.click(screen.getByRole('option', { name: 'beras' }))
  fireEvent.click(screen.getByText('Save category').closest('button'))
}

beforeEach(() => {
  vi.mocked(useProductIdentity).mockReturnValue({
    data: identity,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  })
  vi.mocked(useTaxonomyBuckets).mockReturnValue({
    data: { version: 'v0.4', buckets: BUCKETS },
    isLoading: false,
    isError: false,
  })
  vi.mocked(useSetReviewCategory).mockReturnValue({ mutate: saveMutate, isPending: false })
  vi.mocked(useRevertProductCategory).mockReturnValue({ mutate: revertMutate, isPending: false })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('CategoryOverrideForm — real copy', () => {
  it('renders the header, provenance and frozen-pair note as real sentences', () => {
    const { container } = renderForm()
    expect(container.textContent).toContain('Assigned by pipeline · v0.3')
    expect(container.textContent).toContain(
      "The flagged pair keeps its frozen labels; only the product's category moves."
    )
    expect(container.textContent).toContain('New category')
    expect(container.textContent).toContain(
      'Search the sealed list; the assigned category and the rules answer are offered first.'
    )
  })

  it('renders the human provenance when the category was overridden', () => {
    vi.mocked(useProductIdentity).mockReturnValue({
      data: {
        ...identity,
        product: {
          ...identity.product,
          category: 'beras',
          categoryVersion: 'v0.4',
          categorySource: 'human',
        },
        categoryAudit: [
          {
            id: 'set-1',
            action: 'set',
            oldCategory: 'snack',
            newCategory: 'beras',
            metadataVersionAfter: 3,
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    const { getByTestId } = renderForm()
    expect(getByTestId('category-override-current').textContent).toMatch(/Human override — set/)
  })

  it('renders the no-category provenance for an uncategorized product', () => {
    vi.mocked(useProductIdentity).mockReturnValue({
      data: {
        ...identity,
        product: {
          ...identity.product,
          category: null,
          categoryVersion: null,
          categorySource: null,
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    const { getByTestId } = renderForm()
    expect(getByTestId('category-override-current').textContent).toContain('No category assigned')
  })

  it('pins the category_unknown re-pick copy and keeps the draft visible', () => {
    const { container } = renderForm()
    pickAndSubmit(container)

    const [, options] = saveMutate.mock.calls[0]
    act(() => {
      options.onError(new ApiError('bad request', 400, null, { error: 'category_unknown' }))
    })
    const notice = screen.getByTestId('category-override-unknown')
    expect(notice.textContent).toContain('That category is not in the sealed list')
    expect(notice.textContent).toContain('pick again from the refreshed list. Your draft is kept.')
    expect(
      container.querySelector('[data-testid="category-picker"] > button').textContent
    ).toContain('beras')
  })

  it('pins the stale_category copy (never auto-resubmit)', () => {
    const { container } = renderForm()
    pickAndSubmit(container)

    const [, options] = saveMutate.mock.calls[0]
    act(() => {
      options.onError(new ApiError('stale', 409, null, { error: 'stale_category' }))
    })
    const notice = screen.getByTestId('category-override-stale')
    expect(notice.textContent).toContain('Someone changed this category')
    expect(notice.textContent).toContain('Review the current category and save again')
    // The draft survives a CAS loss.
    expect(
      container.querySelector('[data-testid="category-picker"] > button').textContent
    ).toContain('beras')
  })

  it('pins the busy line while the write is in flight', () => {
    vi.mocked(useSetReviewCategory).mockReturnValue({ mutate: saveMutate, isPending: true })
    renderForm()
    expect(screen.getByText('Recording…')).toBeTruthy()
    expect(screen.getByText('Saving…')).toBeTruthy()
  })
})

describe('CategoryRevertBlock — real copy', () => {
  const revertableIdentity = {
    ...identity,
    product: {
      ...identity.product,
      category: 'beras',
      categoryVersion: 'v0.4',
      categorySource: 'human',
    },
    categoryAudit: [
      {
        id: 'cat-set-1',
        action: 'set',
        oldCategory: 'snack',
        oldCategoryVersion: 'v0.3',
        newCategory: 'beras',
        newCategoryVersion: 'v0.4',
        reason: null,
        actorUserId: 'admin-1',
        reviewItemId: 'rev-1',
        metadataVersionBefore: 2,
        metadataVersionAfter: 3,
        revertsAuditId: null,
        createdAt: '2026-11-18T06:00:00Z',
      },
    ],
  }

  function renderRevertBlock() {
    vi.mocked(useProductIdentity).mockReturnValue({
      data: revertableIdentity,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    return render(<CategoryRevertBlock productKey={PRODUCT_KEY} isAdmin />)
  }

  it('renders the revert offer as a real sentence with the old → new slugs', () => {
    const { container } = renderRevertBlock()
    expect(container.textContent).toContain('Current category')
    expect(container.textContent).toContain('Human override — set')
    expect(container.textContent).toContain('Latest override: snack → beras')
    expect(container.textContent).toContain('Revert category')
  })

  it('pins the confirm dialog copy', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderRevertBlock()
    fireEvent.click(screen.getByText('Revert category').closest('button'))
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('Revert this override and restore "snack"?')
    )
    confirm.mockRestore()
  })

  it('pins the stale_revert re-read copy', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderRevertBlock()
    fireEvent.click(screen.getByText('Revert category').closest('button'))

    const [, options] = revertMutate.mock.calls[0]
    act(() => {
      options.onError(new ApiError('stale revert', 409, null, { error: 'stale_revert' }))
    })
    const notice = screen.getByTestId('category-revert-stale')
    expect(notice.textContent).toContain('That override is no longer the latest')
    expect(notice.textContent).toContain('The identity was refreshed.')
    confirm.mockRestore()
  })

  it('pins the success copy with the restored category and version', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderRevertBlock()
    fireEvent.click(screen.getByText('Revert category').closest('button'))

    const [, options] = revertMutate.mock.calls[0]
    act(() => {
      options.onSuccess({
        product: { category: 'snack', categoryVersion: 'v0.3', categorySource: null },
        categoryAudit: [],
        indexVersion: 4,
      })
    })
    expect(screen.getByTestId('category-revert-success').textContent).toContain(
      'The category is snack again. Canonical index version 4.'
    )
    confirm.mockRestore()
  })
})
