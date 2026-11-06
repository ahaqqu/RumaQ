import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { ProductRenameForm } from './ProductRenameForm.jsx'
import { ApiError } from '../lib/api'

// Real-copy pass for the canonical rename form (ahaqqu/RumaQ#423).
// ProductRenameForm.test.jsx runs on test-setup's raw-key t() (assertions read
// keys), so a missing or malformed string could render as a literal key with
// nothing failing. This file resolves en.json and interpolates like i18next
// does (the AdminReview.i18n.test.jsx / Home.test.jsx idiom) and pins the REAL
// rendered sentences.
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
  useRenameProduct: vi.fn(),
  useRevertRename: vi.fn(),
}))

import { useProductIdentity, useRenameProduct, useRevertRename } from '../lib/queries/products.js'

const PRODUCT_KEY = 'beras-ramos-5kg--ramos--5-kg'

const identity = {
  product: {
    productKey: PRODUCT_KEY,
    name: 'Beras Ramos 5kg',
    brand: 'Ramos',
    unit: '5 kg',
    status: 'provisional',
    metadataVersion: 3,
  },
  aliases: [],
  stats: { observations: 42, stores: 2 },
  audit: [
    {
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
    },
  ],
}

const renameMutate = vi.fn()
const revertMutate = vi.fn()

function renderForm() {
  return render(<ProductRenameForm productKey={PRODUCT_KEY} />)
}

function typeName(container, value) {
  fireEvent.change(container.querySelector('input'), { target: { value } })
}

function clickText(container, text) {
  fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === text))
}

function lastOptions() {
  return renameMutate.mock.calls[renameMutate.mock.calls.length - 1][1]
}

describe('ProductRenameForm real copy (#423)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useProductIdentity).mockReturnValue({
      data: identity,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    vi.mocked(useRenameProduct).mockReturnValue({ mutate: renameMutate, isPending: false })
    vi.mocked(useRevertRename).mockReturnValue({ mutate: revertMutate, isPending: false })
  })

  it('renders the lead-in labels and the live old → new preview', () => {
    const { container, getByTestId } = renderForm()
    expect(getByTestId('rename-current-name').textContent).toBe('Beras Ramos 5kg')
    expect(getByTestId('rename-preview').textContent).toBe('Same as the current name.')
    expect(container.textContent).toContain('Rename canonical product')
    expect(container.textContent).toContain('New name')
    expect(container.textContent).toContain('Reason (optional)')
    expect(container.textContent).toContain('0/200')
    expect(container.textContent).toContain('42 observations · 2 stores')

    typeName(container, 'Beras Ramos Premium 5 kg')
    expect(getByTestId('rename-preview').textContent).toBe(
      'Beras Ramos 5kg → Beras Ramos Premium 5 kg'
    )
  })

  it('pluralizes the observation and store counts', () => {
    vi.mocked(useProductIdentity).mockReturnValue({
      data: { ...identity, stats: { observations: 1, stores: 1 } },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    const { container } = renderForm()
    // A provisional product that needs renaming is often a single sighting
    // (i18next pluralizes on `count`, so the two nouns are separate keys).
    expect(container.textContent).toContain('1 observation · 1 store')
    expect(container.textContent).not.toContain('1 observations')
  })

  it('lists a 409 duplicate_name conflict with its source in plain English', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos')
    clickText(container, 'Save new name')
    act(() => {
      lastOptions().onError(
        new ApiError('duplicate_name', 409, null, {
          error: 'duplicate_name',
          conflicts: [
            { productKey: 'other', name: 'Beras Ramos', source: 'product' },
            { productKey: 'third', name: 'Beras Ramos', source: 'alias' },
          ],
        })
      )
    })
    const notice = getByTestId('rename-duplicate')
    expect(notice.textContent).toContain('This name is already taken')
    expect(notice.textContent).toContain('Beras Ramos (product)')
    expect(notice.textContent).toContain('Beras Ramos (approved alias)')
  })

  it('lists similar-name warnings with the rounded similarity percentage', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos 5 Kg')
    clickText(container, 'Save new name')
    act(() => {
      lastOptions().onError(
        new ApiError('similar_name', 409, null, {
          error: 'similar_name',
          warnings: [
            { productKey: 'other', name: 'Beras Ramos 5kg', similarity: 0.897 },
            { productKey: 'third', name: 'Beras Ramos', similarity: 0.8 },
          ],
        })
      )
    })
    const notice = getByTestId('rename-similar')
    expect(notice.textContent).toContain('Similar names already exist')
    expect(notice.textContent).toContain('Beras Ramos 5kg — 90% similar')
    expect(notice.textContent).toContain('Beras Ramos — 80% similar')
    expect(notice.textContent).toContain('Rename anyway')
  })

  it('confirms a successful rename with the index-version hint in plain English', () => {
    const { container, getByTestId } = renderForm()
    typeName(container, 'Beras Ramos Premium 5 kg')
    clickText(container, 'Save new name')
    act(() => {
      lastOptions().onSuccess({
        product: { ...identity.product, name: 'Beras Ramos Premium 5 kg', metadataVersion: 4 },
        warnings: [],
        audit: [],
        indexVersion: 12,
      })
    })
    const success = getByTestId('rename-success')
    expect(success.textContent).toContain('Renamed')
    expect(success.textContent).toContain(
      'The canonical index is now version 12. The pipeline picks up the new name on its next run.'
    )
  })

  it('asks for confirmation in plain English before reverting', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = renderForm()
    expect(container.textContent).toContain('Latest rename: Beras Ramos → Beras Ramos 5kg')
    clickText(container, 'Revert rename')
    expect(confirm).toHaveBeenCalledWith(
      'Revert this rename and restore “Beras Ramos”? The audit trail keeps both entries.'
    )
    expect(revertMutate).toHaveBeenCalledWith(
      expect.objectContaining({ productKey: PRODUCT_KEY, auditId: 'audit-1' }),
      expect.any(Object)
    )
    confirm.mockRestore()
  })
})
