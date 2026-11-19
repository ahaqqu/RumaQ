import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, screen, act } from '@testing-library/react'
import React from 'react'
import { CategoryRevertBlock } from './CategoryRevertBlock.jsx'
import { ApiError } from '../lib/api'

// The shared revert block's own contract (ahaqqu/RumaQ#728): the
// linear-history derivation (latest receipt only, unreverted, still the live
// category), the admin gate, the confirm dialog, and the error mapping. The
// queries are mocked at the hook boundary (the ProductRenameForm.test.jsx
// idiom); the real rendered sentences are pinned in the i18n pass.
vi.mock('../lib/queries/products.js', () => ({
  useProductIdentity: vi.fn(),
  useRevertProductCategory: vi.fn(),
}))

import { useProductIdentity, useRevertProductCategory } from '../lib/queries/products.js'

const PRODUCT_KEY = 'beras-ramos-5kg--ramos--5-kg'

function identity(overrides = {}) {
  return {
    product: {
      id: 'product-1',
      productKey: PRODUCT_KEY,
      name: 'Beras Ramos 5kg',
      brand: null,
      unit: '5 kg',
      status: 'provisional',
      category: 'beras',
      categoryVersion: 'v0.4',
      categorySource: 'human',
      metadataVersion: 3,
      firstSeenAt: '2026-10-01T00:00:00Z',
      lastSeenAt: '2026-10-28T00:00:00Z',
      updatedAt: '2026-11-18T06:00:00Z',
    },
    aliases: [],
    stats: { observations: 4, stores: 2 },
    audit: [],
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
    ...overrides,
  }
}

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

function renderBlock(props = {}) {
  return render(<CategoryRevertBlock productKey={PRODUCT_KEY} isAdmin {...props} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIdentity(identity())
  vi.mocked(useRevertProductCategory).mockReturnValue({ mutate: revertMutate, isPending: false })
})

describe('CategoryRevertBlock', () => {
  it('renders the current category with its provenance', () => {
    const { getByTestId } = renderBlock()
    const line = getByTestId('category-revert-provenance')
    expect(line.textContent).toContain('beras')
    expect(line.textContent).toContain('override.humanSet')
  })

  it('renders the pipeline provenance for a pipeline-assigned category', () => {
    mockIdentity(
      identity({
        product: { ...identity().product, categorySource: null, categoryVersion: 'v0.3' },
      })
    )
    const { getByTestId } = renderBlock()
    const line = getByTestId('category-revert-provenance')
    expect(line.textContent).toContain('beras')
    expect(line.textContent).toContain('override.assignedByPipeline')
  })

  it('renders the no-category state when the row is uncategorized', () => {
    mockIdentity(
      identity({
        product: { category: null, categoryVersion: null, categorySource: null },
        categoryAudit: [],
      })
    )
    const { getByTestId, container } = renderBlock()
    expect(getByTestId('category-revert-provenance').textContent).toContain(
      'override.noCategoryValue'
    )
    // Nothing to compensate: no revert affordance without a latest set.
    expect(container.textContent).not.toContain('override.revertAction')
  })

  it('offers the revert only when the latest receipt is an unreverted set producing the live category', () => {
    const { container } = renderBlock()
    expect(container.textContent).toContain('override.revertLatest')

    // An older set (the version moved on) is historical — no button.
    mockIdentity(
      identity({
        categoryAudit: [{ action: 'set', metadataVersionAfter: 2, newCategory: 'beras' }],
      })
    )
    const { container: older } = renderBlock()
    expect(older.textContent).not.toContain('override.revertAction')

    // A compensating revert names the set — no second compensation.
    mockIdentity(
      identity({
        categoryAudit: [
          { action: 'revert', metadataVersionAfter: 3, newCategory: 'snack', oldCategory: 'beras' },
        ],
      })
    )
    const { container: reverted } = renderBlock()
    expect(reverted.textContent).not.toContain('override.revertAction')
  })

  it('gates the revert on isAdmin while the provenance line stays', () => {
    const { container } = renderBlock({ isAdmin: false })
    expect(container.textContent).toContain('override.humanSet')
    expect(container.textContent).not.toContain('override.revertAction')
  })

  it('renders nothing when the identity read fails (the parent owns its load-error UI)', () => {
    mockIdentity(undefined, { isError: true })
    const { container } = renderBlock()
    expect(container.querySelector('[data-testid="category-revert-block"]')).toBeNull()
  })

  it('confirms, then sends productKey + expectedMetadataVersion', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = renderBlock()
    fireEvent.click(screen.getByText('override.revertAction').closest('button'))

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(revertMutate).toHaveBeenCalledTimes(1)
    const [vars] = revertMutate.mock.calls[0]
    expect(vars).toMatchObject({ productKey: PRODUCT_KEY, expectedMetadataVersion: 3 })
    expect(container.getAttribute('aria-busy')).toBeNull()
    confirm.mockRestore()
  })

  it('does nothing when the confirm is declined', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderBlock()
    fireEvent.click(screen.getByText('override.revertAction').closest('button'))
    expect(revertMutate).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('shows the success notice after a committed revert', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = renderBlock()
    fireEvent.click(screen.getByText('override.revertAction').closest('button'))

    const [vars, options] = revertMutate.mock.calls[0]
    expect(vars.productKey).toBe(PRODUCT_KEY)
    act(() => {
      options.onSuccess({
        product: { category: 'snack', categoryVersion: 'v0.3', categorySource: null },
        categoryAudit: [],
        indexVersion: 4,
      })
    })
    // The notice names the restored state and the index version (the raw-key
    // pass proves the slot exists; the real interpolated sentences are pinned
    // in the i18n pass).
    expect(screen.getByTestId('category-revert-success')).toBeTruthy()
    expect(container.textContent).toContain('override.revertSuccessTitle')
    confirm.mockRestore()
  })

  it('maps 409 stale_revert to the re-read notice', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderBlock()
    fireEvent.click(screen.getByText('override.revertAction').closest('button'))

    const [, options] = revertMutate.mock.calls[0]
    act(() => {
      options.onError(new ApiError('stale revert', 409, null, { error: 'stale_revert' }))
    })
    expect(screen.getByTestId('category-revert-stale').textContent).toContain(
      'override.revertStaleTitle'
    )
    confirm.mockRestore()
  })

  it('maps 409 stale_product and generic failures to their copy', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderBlock()
    fireEvent.click(screen.getByText('override.revertAction').closest('button'))

    const [, options] = revertMutate.mock.calls[0]
    act(() => {
      options.onError(new ApiError('stale', 409, null, { error: 'stale_product' }))
    })
    expect(screen.getByTestId('category-revert-stale').textContent).toContain('override.staleTitle')

    fireEvent.click(screen.getByText('override.revertAction').closest('button'))
    const [, options2] = revertMutate.mock.calls[1]
    act(() => {
      options2.onError(new ApiError('boom', 500))
    })
    expect(screen.getByTestId('category-revert-error').textContent).toBe('override.errorGeneric')
    confirm.mockRestore()
  })
})
