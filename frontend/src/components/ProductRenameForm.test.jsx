import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test'
import { render, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { ProductRenameForm } from './ProductRenameForm.jsx'
import { ApiError } from '../lib/api'

// The two query modules are mocked at the hook boundary (the AdminReview.test.jsx
// idiom): these tests cover the form's state machine — server answers mapped to
// inline copy — not React Query itself.
vi.mock('../lib/queries/products.js', () => ({
  useProductIdentity: vi.fn(),
  useRenameProduct: vi.fn(),
  useRevertRename: vi.fn(),
}))

import { useProductIdentity, useRenameProduct, useRevertRename } from '../lib/queries/products.js'

const PRODUCT_KEY = 'beras-ramos-5kg--ramos--5-kg'

const LATEST_RENAME = {
  id: 'audit-1',
  action: 'rename',
  oldName: 'Beras Ramos',
  newName: 'Beras Ramos 5kg',
  reason: null,
  actorUserId: 'user-1',
  metadataVersionBefore: 2,
  metadataVersionAfter: 3,
  revertsAuditId: null,
  createdAt: '2026-10-28T10:00:00Z',
}

function identity(overrides = {}) {
  return {
    product: {
      id: 'product-1',
      productKey: PRODUCT_KEY,
      name: 'Beras Ramos 5kg',
      brand: 'Ramos',
      unit: '5 kg',
      status: 'provisional',
      metadataVersion: 3,
      firstSeenAt: '2026-10-01T00:00:00Z',
      lastSeenAt: '2026-10-28T00:00:00Z',
      updatedAt: '2026-10-28T00:00:00Z',
    },
    aliases: [
      {
        name: 'Beras Ramos 5 kg',
        storeSlug: 'lotte-mart',
        status: 'candidate',
        source: 'ocr',
        firstSeenAt: '2026-10-25T00:00:00Z',
        lastSeenAt: '2026-10-28T00:00:00Z',
      },
      {
        name: 'Beras Ramos',
        storeSlug: 'superindo',
        status: 'approved',
        source: 'catalog',
        firstSeenAt: '2026-10-20T00:00:00Z',
        lastSeenAt: '2026-10-27T00:00:00Z',
      },
      {
        // The third status (#489): a decision the backend can now return.
        // Without its label the form fell back to "candidate".
        name: 'Ramos 5 KG',
        storeSlug: 'alfamart',
        status: 'rejected',
        source: 'ocr',
        firstSeenAt: '2026-10-18T00:00:00Z',
        lastSeenAt: '2026-10-26T00:00:00Z',
      },
    ],
    stats: { observations: 42, stores: 2 },
    audit: [LATEST_RENAME],
    ...overrides,
  }
}

const renameMutate = vi.fn()
const revertMutate = vi.fn()
const refetch = vi.fn()

function mockIdentity(value = identity()) {
  vi.mocked(useProductIdentity).mockReturnValue({
    data: value,
    isLoading: false,
    isError: false,
    refetch,
  })
}

function renderForm(props = {}) {
  return render(<ProductRenameForm productKey={PRODUCT_KEY} {...props} />)
}

function nameInput(container) {
  return container.querySelector('input')
}

function typeName(container, value) {
  fireEvent.change(nameInput(container), { target: { value } })
}

function submitButton(container) {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'rename.submit'
  )
}

function lastRenameVariables() {
  return renameMutate.mock.calls[renameMutate.mock.calls.length - 1][0]
}

function lastRenameOptions() {
  return renameMutate.mock.calls[renameMutate.mock.calls.length - 1][1]
}

// The suite's i18n mock returns raw keys, so assertions match keys — except for
// data the app renders verbatim (product names, store slugs).
describe('ProductRenameForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIdentity()
    vi.mocked(useRenameProduct).mockReturnValue({ mutate: renameMutate, isPending: false })
    vi.mocked(useRevertRename).mockReturnValue({ mutate: revertMutate, isPending: false })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the identity for its product key and renders the current name, aliases and stats', () => {
    const { container, getByTestId } = renderForm()
    expect(useProductIdentity).toHaveBeenCalledWith(PRODUCT_KEY, { enabled: true })
    expect(getByTestId('rename-current-name').textContent).toBe('Beras Ramos 5kg')
    expect(nameInput(container).value).toBe('Beras Ramos 5kg')
    expect(getByTestId('rename-preview').textContent).toBe('rename.previewSame')
    expect(container.textContent).toContain('rename.observations')
    // Alias evidence: name, store, status and source all visible.
    const aliases = getByTestId('rename-aliases')
    expect(aliases.textContent).toContain('Beras Ramos 5 kg')
    expect(aliases.textContent).toContain('lotte-mart')
    expect(aliases.textContent).toContain('rename.aliasStatusCandidate')
    expect(aliases.textContent).toContain('rename.aliasSourceOcr')
    expect(aliases.textContent).toContain('rename.aliasStatusApproved')
    expect(aliases.textContent).toContain('rename.aliasSourceCatalog')
    // #489: 'rejected' is its own label, not the candidate fallback.
    const rows = aliases.querySelectorAll('li')
    expect(rows).toHaveLength(3)
    expect(rows[2].textContent).toContain('rename.aliasStatusRejected')
    expect(rows[2].textContent).not.toContain('rename.aliasStatusCandidate')
  })

  it('previews old → new live and submits the optimistic metadata version', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos Premium 5 kg')
    expect(getByTestId('rename-preview').textContent).toBe('rename.previewOldToNew')
    expect(submitButton(container).disabled).toBe(false)

    fireEvent.click(submitButton(container))
    expect(renameMutate).toHaveBeenCalledTimes(1)
    expect(lastRenameVariables()).toEqual({
      productKey: PRODUCT_KEY,
      canonicalName: 'Beras Ramos Premium 5 kg',
      expectedMetadataVersion: 3,
    })
  })

  it('sends the optional reason, which is capped at 200 characters', () => {
    const { container } = renderForm()
    const textarea = container.querySelector('textarea')
    expect(textarea.getAttribute('maxlength')).toBe('200')
    fireEvent.change(textarea, { target: { value: 'salah tulis ukuran' } })
    typeName(container, 'Beras Ramos Premium 5 kg')
    fireEvent.click(submitButton(container))
    expect(lastRenameVariables().reason).toBe('salah tulis ukuran')
  })

  it('never submits an unchanged or blank name', () => {
    const { container } = renderForm()
    expect(submitButton(container).disabled).toBe(true)
    fireEvent.click(submitButton(container))
    typeName(container, '   ')
    expect(submitButton(container).disabled).toBe(true)
    fireEvent.click(submitButton(container))
    expect(renameMutate).not.toHaveBeenCalled()
    expect(container.textContent).toContain('rename.previewEmpty')
  })

  it('maps 409 duplicate_name to a conflict list and blocks retrying the same name', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos')
    fireEvent.click(submitButton(container))
    act(() => {
      lastRenameOptions().onError(
        new ApiError('duplicate_name', 409, null, {
          error: 'duplicate_name',
          conflicts: [
            { productKey: 'other-product', name: 'Beras Ramos', source: 'product' },
            { productKey: 'third-product', name: 'Beras Ramos', source: 'alias' },
          ],
        })
      )
    })

    const notice = getByTestId('rename-duplicate')
    expect(notice.textContent).toContain('rename.duplicateTitle')
    expect(notice.textContent).toContain('rename.duplicateDesc')
    // One row per conflict; the interpolated name/source copy is pinned in
    // ProductRenameForm.i18n.test.jsx (this suite's t() returns raw keys).
    const conflicts = getByTestId('rename-conflict-list').querySelectorAll('li')
    expect(conflicts).toHaveLength(2)
    expect([...conflicts].map((li) => li.textContent)).toEqual([
      'rename.duplicateConflict',
      'rename.duplicateConflict',
    ])
    // No acknowledgement path exists for a duplicate: the same name cannot be
    // retried, editing it re-enables the submit.
    expect(container.textContent).not.toContain('rename.similarAnyway')
    expect(submitButton(container).disabled).toBe(true)
    fireEvent.click(submitButton(container))
    expect(renameMutate).toHaveBeenCalledTimes(1)
    typeName(container, 'Beras Ramos Premium 5 kg')
    expect(submitButton(container).disabled).toBe(false)
  })

  it('focuses the notice and marks the name field invalid on a name conflict', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos')
    fireEvent.click(submitButton(container))
    act(() => {
      lastRenameOptions().onError(
        new ApiError('duplicate_name', 409, null, {
          error: 'duplicate_name',
          conflicts: [{ productKey: 'other-product', name: 'Beras Ramos', source: 'product' }],
        })
      )
    })

    // The answer is the first error, so it takes focus; the input owns the
    // relationship (invalid + described by the notice) for the way back.
    const notice = getByTestId('rename-notice')
    expect(document.activeElement).toBe(notice)
    const input = nameInput(container)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby').split(' ')).toContain(notice.id)
  })

  it('maps 409 similar_name to warnings resubmitted with acknowledgeWarnings', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos 5 Kg')
    fireEvent.click(submitButton(container))
    act(() => {
      lastRenameOptions().onError(
        new ApiError('similar_name', 409, null, {
          error: 'similar_name',
          warnings: [{ productKey: 'other-product', name: 'Beras Ramos 5kg', similarity: 0.9 }],
        })
      )
    })

    expect(getByTestId('rename-similar').textContent).toContain('rename.similarTitle')
    const warnings = getByTestId('rename-similar-list').querySelectorAll('li')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].textContent).toBe('rename.similarRow')

    fireEvent.click(
      [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'rename.similarAnyway'
      )
    )
    expect(renameMutate).toHaveBeenCalledTimes(2)
    expect(lastRenameVariables()).toEqual({
      productKey: PRODUCT_KEY,
      canonicalName: 'Beras Ramos 5 Kg',
      expectedMetadataVersion: 3,
      acknowledgeWarnings: true,
    })
  })

  it('withdraws the acknowledgement when the name changes after the 409', () => {
    const { container, getByTestId } = renderForm()
    const acknowledge = () =>
      [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'rename.similarAnyway'
      )
    typeName(container, 'Beras Ramos 5 Kg')
    fireEvent.click(submitButton(container))
    act(() => {
      lastRenameOptions().onError(
        new ApiError('similar_name', 409, null, {
          error: 'similar_name',
          warnings: [{ productKey: 'other-product', name: 'Beras Ramos 5kg', similarity: 0.9 }],
        })
      )
    })
    expect(acknowledge()).not.toBeUndefined()

    // The warnings describe "Beras Ramos 5 Kg" only: acknowledging them for a
    // different draft would let the edited name past the similar-name guard.
    typeName(container, 'Beras Ramos Kiloan Super')
    expect(acknowledge()).toBeUndefined()
    expect(getByTestId('rename-similar')).not.toBeUndefined()

    // Back to the name the warnings belong to — the override returns.
    typeName(container, 'Beras Ramos 5 Kg')
    expect(acknowledge()).not.toBeUndefined()
    fireEvent.click(acknowledge())
    expect(lastRenameVariables()).toEqual({
      productKey: PRODUCT_KEY,
      canonicalName: 'Beras Ramos 5 Kg',
      expectedMetadataVersion: 3,
      acknowledgeWarnings: true,
    })
  })

  it('submits the version the refetch produced after a stale_product', () => {
    const { container, rerender } = render(<ProductRenameForm productKey={PRODUCT_KEY} />)
    typeName(container, 'Beras Ramos Premium 5 kg')
    fireEvent.click(submitButton(container))
    expect(lastRenameVariables().expectedMetadataVersion).toBe(3)
    act(() => {
      lastRenameOptions().onError(
        new ApiError('stale_product', 409, null, {
          error: 'stale_product',
          current: { name: 'Beras Ramos 5kg', metadataVersion: 4 },
        })
      )
    })

    // The re-read identity lands with a newer version: the typed name survives
    // and the next submit echoes the version it now knows about.
    mockIdentity(identity({ product: { ...identity().product, metadataVersion: 4 } }))
    rerender(<ProductRenameForm productKey={PRODUCT_KEY} />)
    expect(nameInput(container).value).toBe('Beras Ramos Premium 5 kg')
    fireEvent.click(submitButton(container))
    expect(lastRenameVariables()).toEqual({
      productKey: PRODUCT_KEY,
      canonicalName: 'Beras Ramos Premium 5 kg',
      expectedMetadataVersion: 4,
    })
  })

  it('refuses a second submit while the rename is in flight', () => {
    vi.mocked(useRenameProduct).mockReturnValue({ mutate: renameMutate, isPending: true })
    const { container } = renderForm()
    typeName(container, 'Beras Ramos Premium 5 kg')
    // The button swaps to its busy label and disables itself…
    expect(submitButton(container)).toBeUndefined()
    expect(container.textContent).toContain('rename.submitBusy')
    // …and the form's other entry point (Enter in the name input) is guarded
    // too, so one rename can never fire two mutations.
    fireEvent.submit(container.querySelector('form'))
    expect(renameMutate).not.toHaveBeenCalled()
  })

  it('maps 404, 403, 400 and network failures to localized copy without stalling', () => {
    const cases = [
      { error: new ApiError('RAW_404_PRODUCT', 404), key: 'rename.errorNotFound' },
      { error: new ApiError('RAW_403_FORBIDDEN', 403), key: 'rename.errorForbidden' },
      { error: new ApiError('RAW_400_NAME_MUST_DIFFER', 400), key: 'rename.errorInvalid' },
      { error: new Error('RAW_NETWORK_FAILURE'), key: 'rename.errorGeneric' },
    ]
    for (const { error, key } of cases) {
      const { container, getByTestId, unmount } = renderForm()
      typeName(container, 'Beras Ramos Premium 5 kg')
      fireEvent.click(submitButton(container))
      act(() => {
        lastRenameOptions().onError(error)
      })
      // Never the raw server string, and never a stuck busy state.
      expect(getByTestId('rename-error').textContent).toBe(key)
      expect(container.textContent).not.toContain(error.message)
      expect(submitButton(container).disabled).toBe(false)
      unmount()
    }
  })

  it('maps 409 stale_product to a refetch, keeps the typed name and never resubmits', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos Premium 5 kg')
    fireEvent.click(submitButton(container))
    act(() => {
      lastRenameOptions().onError(
        new ApiError('stale_product', 409, null, {
          error: 'stale_product',
          current: { name: 'Beras Ramos 5kg', metadataVersion: 4 },
        })
      )
    })

    expect(refetch).toHaveBeenCalledTimes(1)
    expect(getByTestId('rename-stale').textContent).toContain('rename.staleTitle')
    expect(getByTestId('rename-stale').textContent).toContain('rename.staleDesc')
    // The prefill stays; the admin reviews the new values and submits by hand.
    expect(nameInput(container).value).toBe('Beras Ramos Premium 5 kg')
    expect(renameMutate).toHaveBeenCalledTimes(1)
  })

  it('confirms before reverting and sends the latest rename audit id', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = renderForm()
    const revertButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'rename.revertAction'
    )
    expect(revertButton).not.toBeUndefined()
    fireEvent.click(revertButton)
    expect(confirm).toHaveBeenCalledWith('rename.revertConfirm')
    expect(revertMutate).toHaveBeenCalledTimes(1)
    expect(revertMutate.mock.calls[0][0]).toEqual({
      productKey: PRODUCT_KEY,
      auditId: LATEST_RENAME.id,
    })
  })

  it('does not revert when the confirmation is dismissed', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container } = renderForm()
    fireEvent.click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'rename.revertAction'
      )
    )
    expect(revertMutate).not.toHaveBeenCalled()
  })

  it('offers revert only for the latest rename', () => {
    // The latest audit row is already a revert.
    mockIdentity(
      identity({
        audit: [
          { ...LATEST_RENAME, id: 'audit-2', action: 'revert', revertsAuditId: LATEST_RENAME.id },
        ],
      })
    )
    const reverted = renderForm()
    expect(reverted.container.textContent).not.toContain('rename.revertAction')
    reverted.unmount()

    // A rename that is no longer the write which produced the current version.
    mockIdentity(identity({ audit: [{ ...LATEST_RENAME, metadataVersionAfter: 2 }] }))
    const older = renderForm()
    expect(older.container.textContent).not.toContain('rename.revertAction')
    older.unmount()

    // The default fixture: audit[0] IS the latest rename.
    mockIdentity()
    const latest = renderForm()
    expect(latest.container.textContent).toContain('rename.revertAction')
  })

  it('maps 409 stale_revert to a refetch and an inline notice', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container, getByTestId } = renderForm()
    fireEvent.click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'rename.revertAction'
      )
    )
    act(() => {
      revertMutate.mock.calls[0][1].onError(
        new ApiError('stale_revert', 409, null, { error: 'stale_revert' })
      )
    })
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(getByTestId('rename-revert-stale').textContent).toContain('rename.revertStaleTitle')
    expect(getByTestId('rename-revert-stale').textContent).toContain('rename.revertStaleDesc')
  })

  it('confirms a successful rename with the index version and keeps the new name in the form', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos Premium 5 kg')
    fireEvent.click(submitButton(container))
    act(() => {
      lastRenameOptions().onSuccess({
        product: { ...identity().product, name: 'Beras Ramos Premium 5 kg', metadataVersion: 4 },
        warnings: [],
        audit: [],
        indexVersion: 12,
      })
    })

    const success = getByTestId('rename-success')
    expect(success.textContent).toContain('rename.successTitle')
    expect(success.textContent).toContain('rename.successBody')
    // Focus lands on the confirmation instead of being dropped to <body> when
    // the submit button disables itself.
    expect(document.activeElement).toBe(getByTestId('rename-notice'))
    // The form stays open showing the committed name; resubmitting it is final.
    expect(nameInput(container).value).toBe('Beras Ramos Premium 5 kg')
    expect(submitButton(container).disabled).toBe(true)
  })

  it('reports the similar-name warnings an acknowledged rename overrode', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos 5 Kg')
    fireEvent.click(submitButton(container))
    act(() => {
      lastRenameOptions().onSuccess({
        product: { ...identity().product, name: 'Beras Ramos 5 Kg', metadataVersion: 4 },
        warnings: [{ productKey: 'other-product', name: 'Beras Ramos 5kg', similarity: 0.9 }],
        audit: [],
        indexVersion: 13,
      })
    })
    expect(getByTestId('rename-success').textContent).toContain('rename.similarAcknowledged')
  })

  it('maps a revert success to the restored name and index version', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container, getByTestId } = renderForm()
    fireEvent.click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'rename.revertAction'
      )
    )
    act(() => {
      revertMutate.mock.calls[0][1].onSuccess({
        product: { ...identity().product, name: 'Beras Ramos', metadataVersion: 4 },
        warnings: [],
        audit: [],
        indexVersion: 14,
      })
    })
    const success = getByTestId('rename-success')
    expect(success.textContent).toContain('rename.revertSuccessTitle')
    expect(success.textContent).toContain('rename.revertSuccessBody')
    expect(nameInput(container).value).toBe('Beras Ramos')
  })

  it('renders the load failure with a retry and no submit affordance', () => {
    vi.mocked(useProductIdentity).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    })
    const { container } = renderForm()
    expect(container.textContent).toContain('rename.loadError')
    fireEvent.click(
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'rename.retry')
    )
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(submitButton(container)).toBeUndefined()
  })
})
