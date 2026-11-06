import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Documents } from './Documents.jsx'
import { ApiError } from '../lib/api'

// Initialized-i18n pass over the vault page's copy (review T4-A2): the main
// Documents suite runs on test-setup's raw-key t() (assertions read keys), so
// an unresolvable interpolation — the {{date}} the expiryRead copy needs —
// rendered as a literal placeholder without anything failing. This file
// resolves en.json and interpolates like i18next does (the Home.test.jsx
// idiom) and pins the REAL rendered sentences.
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

vi.mock('../lib/queries/index.js', () => ({
  DOCUMENTS_BASE_KEY: ['documents'],
  documentsQueryKey: () => ['documents'],
  useHouseholds: vi.fn(),
  useHouseholdMembers: vi.fn(),
  useDocuments: vi.fn(),
  useCreateDocument: vi.fn(),
  useAddDocumentFile: vi.fn(),
  useDeleteDocument: vi.fn(),
  useDeleteDocumentFile: vi.fn(),
  useUpdateDocumentExpiry: vi.fn(),
  useExtractDocumentExpiry: vi.fn(),
}))

// The page (and the viewer it can open) also pull api constants — keep the
// signature table, but the REAL ApiError: the 429 copy rides its
// retryAfterSeconds (review T4-B6).
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchDocumentContent: vi.fn(),
  }
})

import {
  useHouseholds,
  useHouseholdMembers,
  useDocuments,
  useCreateDocument,
  useAddDocumentFile,
  useDeleteDocument,
  useDeleteDocumentFile,
  useUpdateDocumentExpiry,
  useExtractDocumentExpiry,
} from '../lib/queries/index.js'

function mutation(overrides = {}) {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, ...overrides }
}

const HOUSEHOLDS = {
  households: [
    { id: 'h1', name: 'Keluarga Putri', role: 'owner', member_count: 1, is_active: true },
  ],
}

const DOC = {
  id: 'doc-1',
  household_id: 'h1',
  member_id: null,
  name: 'Paspor Bapak',
  uploaded_by: 'u1',
  created_at: '2026-11-03 10:00:00',
  files: [
    {
      id: 'file-jpg',
      file_name: 'paspor-depan.jpg',
      content_type: 'image/jpeg',
      size_bytes: 1024,
    },
  ],
}

function renderDocuments() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    React.createElement(QueryClientProvider, { client }, React.createElement(Documents, null))
  )
}

describe('Documents — initialized i18n copy (expiryRead interpolation, T4-A2)', () => {
  let extractMutation

  beforeEach(() => {
    vi.clearAllMocks()
    extractMutation = mutation()
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: { members: [] }, isLoading: false })
    vi.mocked(useDocuments).mockReturnValue({
      data: { documents: [DOC] },
      isLoading: false,
    })
    // The page reads isPending off every mutation hook it mounts.
    vi.mocked(useCreateDocument).mockReturnValue(mutation())
    vi.mocked(useAddDocumentFile).mockReturnValue(mutation())
    vi.mocked(useDeleteDocument).mockReturnValue(mutation())
    vi.mocked(useDeleteDocumentFile).mockReturnValue(mutation())
    vi.mocked(useUpdateDocumentExpiry).mockReturnValue(mutation())
    vi.mocked(useExtractDocumentExpiry).mockReturnValue(extractMutation)
  })

  it('renders the suggested DATE in the read-date success feedback, not a raw placeholder', async () => {
    // The regression: t('documents.expiryRead', { name }) left the copy's
    // {{date}} as literal text ("Read {{date}} from paspor-depan.jpg").
    extractMutation.mutateAsync.mockResolvedValue({
      expires_on: '2031-05-20',
      model: 'vision-model',
    })
    const { container } = renderDocuments()
    fireEvent.click(container.querySelector('[data-testid="read-date"]'))
    await waitFor(() =>
      expect(container.textContent).toContain(
        'Read 2031-05-20 from paspor-depan.jpg — check it and save.'
      )
    )
    expect(container.textContent).not.toContain('{{date}}')
  })

  it('maps a rate-limited OCR (429 + Retry-After) to copy that says when to come back', async () => {
    // Review T4-B6: a 429 must not read as the generic "try again" — the
    // Retry-After the backend sends is the actionable part.
    extractMutation.mutateAsync.mockRejectedValue(new ApiError('Too many OCR requests.', 429, 45))
    const { container } = renderDocuments()
    fireEvent.click(container.querySelector('[data-testid="read-date"]'))
    await waitFor(() =>
      expect(container.textContent).toContain('Too many requests. Please try again in 45 seconds.')
    )
  })

  it('falls back to the plain slow-down copy when no Retry-After survives', async () => {
    extractMutation.mutateAsync.mockRejectedValue(new ApiError('Too many OCR requests.', 429))
    const { container } = renderDocuments()
    fireEvent.click(container.querySelector('[data-testid="read-date"]'))
    await waitFor(() =>
      expect(container.textContent).toContain(
        'Too many requests. Please wait a moment and try again.'
      )
    )
  })
})
