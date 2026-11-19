import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, screen, act } from '@testing-library/react'
import React from 'react'
import { CategoryOverrideForm } from './CategoryOverrideForm.jsx'
import { ApiError } from '../lib/api'

// The override panel's state machine (ahaqqu/RumaQ#728), the
// ProductRenameForm.test.jsx idiom: the query modules are mocked at the hook
// boundary and the test i18n renders raw keys, so assertions read keys — the
// REAL rendered sentences are pinned in CategoryOverrideForm.i18n.test.jsx.
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
const REVIEW_ID = 'rev-1'

const BUCKETS = ['sayuran', 'beras', 'buah', 'snack', 'minyak-goreng', 'lainnya', 'es-krim-dessert']

function identity(overrides = {}) {
  return {
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
      firstSeenAt: '2026-10-01T00:00:00Z',
      lastSeenAt: '2026-10-28T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    },
    aliases: [],
    stats: { observations: 4, stores: 2 },
    audit: [],
    categoryAudit: [],
    ...overrides,
  }
}

const saveMutate = vi.fn()
const revertMutate = vi.fn()
const refetch = vi.fn()

function mockIdentity(value, queryOverrides = {}) {
  vi.mocked(useProductIdentity).mockReturnValue({
    data: value,
    isLoading: false,
    isError: false,
    refetch,
    ...queryOverrides,
  })
}

function mockBuckets(overrides = {}) {
  vi.mocked(useTaxonomyBuckets).mockReturnValue({
    data: { version: 'v0.4', buckets: BUCKETS },
    isLoading: false,
    isError: false,
    ...overrides,
  })
}

function renderForm(props = {}) {
  return render(
    <CategoryOverrideForm
      reviewItemId={REVIEW_ID}
      productKey={PRODUCT_KEY}
      assignedCategory="snack"
      rulesCategory="beras"
      isAdmin
      {...props}
    />
  )
}

function pickerTrigger(container) {
  return container.querySelector('[data-testid="category-picker"] > button')
}

function pickerOptions() {
  return screen.getAllByRole('option').map((option) => option.textContent)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIdentity(identity())
  mockBuckets()
  vi.mocked(useSetReviewCategory).mockReturnValue({ mutate: saveMutate, isPending: false })
  vi.mocked(useRevertProductCategory).mockReturnValue({ mutate: revertMutate, isPending: false })
})

describe('CategoryOverrideForm', () => {
  it('shows the identity header: product, current category, provenance, frozen-pair note', () => {
    const { container } = renderForm()
    expect(screen.getByTestId('category-override-product').textContent).toBe('Beras Ramos 5kg')
    expect(screen.getByTestId('category-override-current').textContent).toContain('snack')
    expect(screen.getByTestId('category-override-current').textContent).toContain(
      'override.assignedByPipeline'
    )
    expect(container.textContent).toContain('override.frozenPairNote')
  })

  it('renders the no-category provenance when the product is uncategorized', () => {
    mockIdentity(
      identity({ product: { category: null, categoryVersion: null, categorySource: null } })
    )
    const { getByTestId } = renderForm()
    expect(getByTestId('category-override-current').textContent).toContain(
      'override.noCategoryValue'
    )
    expect(getByTestId('category-override-current').textContent).toContain('override.noCategory')
  })

  it('renders the human provenance when the category was already overridden', () => {
    mockIdentity(
      identity({
        product: { category: 'beras', categoryVersion: 'v0.4', categorySource: 'human' },
        categoryAudit: [
          {
            id: 'set-1',
            action: 'set',
            oldCategory: 'snack',
            newCategory: 'beras',
            metadataVersionAfter: 3,
          },
        ],
      })
    )
    const { getByTestId } = renderForm()
    expect(getByTestId('category-override-current').textContent).toContain('override.humanSet')
  })

  it('offers quick choices first, then the sealed vocabulary, with no reset row', () => {
    const { container } = renderForm()
    fireEvent.click(pickerTrigger(container))

    const options = pickerOptions()
    // Quick choices pinned: the assigned category, then the rules answer.
    expect(options[0]).toBe('snack')
    expect(options[1]).toBe('beras')
    // The sealed slugs follow minus the two quick choices — no "All
    // categories" reset row anywhere (null is not a legal override value).
    expect(options).not.toContain('prices.allCategories')
    expect(options.slice(2)).toEqual(BUCKETS.filter((slug) => slug !== 'snack' && slug !== 'beras'))
  })

  it('keeps Save disabled until a slug that differs from the current category is picked', () => {
    const { container } = renderForm()
    const saveButton = screen.getByText('override.submit').closest('button')
    expect(saveButton.disabled).toBe(true)

    // The assigned category is the first quick choice — picking it must NOT
    // enable Save (confirming is the ack's job).
    fireEvent.click(pickerTrigger(container))
    fireEvent.click(screen.getByRole('option', { name: 'snack' }))
    expect(saveButton.disabled).toBe(true)

    fireEvent.click(pickerTrigger(container))
    fireEvent.click(screen.getByRole('option', { name: 'beras' }))
    expect(saveButton.disabled).toBe(false)
  })

  it('saves with the review id, the picked slug, the sealed version and the reason', () => {
    const { container } = renderForm()
    fireEvent.click(pickerTrigger(container))
    fireEvent.click(screen.getByRole('option', { name: 'beras' }))
    fireEvent.change(screen.getByLabelText('override.reason'), {
      target: { value: '  rules head was right  ' },
    })
    fireEvent.click(screen.getByText('override.submit').closest('button'))

    expect(saveMutate).toHaveBeenCalledTimes(1)
    const vars = saveMutate.mock.calls[0][0]
    expect(vars).toMatchObject({
      id: REVIEW_ID,
      category: 'beras',
      productKey: PRODUCT_KEY,
      version: 'v0.4',
      reason: 'rules head was right',
    })
  })

  it('saves without a reason key when the field is blank', () => {
    const { container } = renderForm()
    fireEvent.click(pickerTrigger(container))
    fireEvent.click(screen.getByRole('option', { name: 'beras' }))
    fireEvent.click(screen.getByText('override.submit').closest('button'))

    expect(saveMutate.mock.calls[0][0]).not.toHaveProperty('reason')
  })

  it('closes the panel on success (the row is the success view)', () => {
    const onClose = vi.fn()
    const { container } = renderForm({ onClose })
    fireEvent.click(pickerTrigger(container))
    fireEvent.click(screen.getByRole('option', { name: 'beras' }))
    fireEvent.click(screen.getByText('override.submit').closest('button'))

    const [vars, options] = saveMutate.mock.calls[0]
    expect(vars.category).toBe('beras')
    act(() => {
      options.onSuccess({})
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('maps 400 category_unknown to the re-pick notice and keeps the draft', () => {
    const { container } = renderForm()
    fireEvent.click(pickerTrigger(container))
    fireEvent.click(screen.getByRole('option', { name: 'beras' }))
    fireEvent.click(screen.getByText('override.submit').closest('button'))

    const [, options] = saveMutate.mock.calls[0]
    act(() => {
      options.onError(new ApiError('bad request', 400, null, { error: 'category_unknown' }))
    })
    expect(screen.getByTestId('category-override-unknown')).toBeTruthy()
    // The draft survives: the trigger still shows the picked slug.
    expect(pickerTrigger(container).textContent).toContain('beras')
    // And Save is still armed (a re-pick is a fresh answer).
    expect(screen.getByText('override.submit').closest('button').disabled).toBe(false)
  })

  it('maps 409 stale_category to the re-read notice, refetches and keeps the draft', () => {
    const { container } = renderForm()
    fireEvent.click(pickerTrigger(container))
    fireEvent.click(screen.getByRole('option', { name: 'beras' }))
    fireEvent.click(screen.getByText('override.submit').closest('button'))

    const [, options] = saveMutate.mock.calls[0]
    act(() => {
      options.onError(new ApiError('stale', 409, null, { error: 'stale_category' }))
    })
    expect(screen.getByTestId('category-override-stale')).toBeTruthy()
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(pickerTrigger(container).textContent).toContain('beras')
    expect(screen.getByText('override.submit').closest('button').disabled).toBe(false)
  })

  it('maps 403 and generic failures to their copy', () => {
    const { container } = renderForm()
    fireEvent.click(pickerTrigger(container))
    fireEvent.click(screen.getByRole('option', { name: 'beras' }))
    fireEvent.click(screen.getByText('override.submit').closest('button'))

    const [, options] = saveMutate.mock.calls[0]
    act(() => {
      options.onError(new ApiError('forbidden', 403))
    })
    expect(container.textContent).toContain('override.errorForbidden')

    fireEvent.click(screen.getByText('override.submit').closest('button'))
    const [, options2] = saveMutate.mock.calls[1]
    act(() => {
      options2.onError(new ApiError('boom', 500))
    })
    expect(screen.getByTestId('category-override-error').textContent).toBe('override.errorGeneric')
  })

  it('renders the load-error block with Retry + Cancel when the identity read fails', () => {
    mockIdentity(undefined, { isError: true })
    const onClose = vi.fn()
    const { container } = renderForm({ onClose })
    expect(container.textContent).toContain('override.loadError')

    fireEvent.click(screen.getByText('override.retry'))
    expect(refetch).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('override.cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders the revert block for an admin and not for a non-admin', () => {
    const { container } = renderForm({ isAdmin: true })
    expect(container.querySelector('[data-testid="category-override-revert"]')).not.toBeNull()

    const { container: plain } = renderForm({ isAdmin: false })
    expect(plain.querySelector('[data-testid="category-override-revert"]')).toBeNull()
  })

  it('shows the vocabulary loading state instead of the picker', () => {
    mockBuckets({ data: undefined, isLoading: true })
    const { container } = renderForm()
    expect(container.textContent).toContain('override.vocabularyLoading')
    expect(container.querySelector('[data-testid="category-picker"]')).toBeNull()
    expect(screen.getByText('override.submit').closest('button').disabled).toBe(true)
  })
})
