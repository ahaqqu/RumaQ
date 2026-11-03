import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Documents } from './Documents.jsx'

// jsdom has no object URL machinery — the viewer turns fetched blobs into
// object URLs and must revoke them on close.
const createObjectURL = vi.fn(() => 'blob:mock-url')
const revokeObjectURL = vi.fn()
window.URL.createObjectURL = createObjectURL
window.URL.revokeObjectURL = revokeObjectURL

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  useHouseholds: vi.fn(),
  useHouseholdMembers: vi.fn(),
  useDocuments: vi.fn(),
  useUploadDocument: vi.fn(),
  useDeleteDocument: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(message, status) {
      super(message)
      this.status = status
    }
  },
  DOCUMENT_CATEGORIES: ['kartu_keluarga', 'ktp', 'kartu_anak', 'akta', 'paspor', 'bpjs', 'lainnya'],
  DOCUMENT_MAX_BYTES: 10 * 1024 * 1024,
  fetchDocumentContent: vi.fn(),
}))

import { useMe } from '../lib/queries/me.js'
import {
  useHouseholds,
  useHouseholdMembers,
  useDocuments,
  useUploadDocument,
  useDeleteDocument,
} from '../lib/queries/index.js'
import { fetchDocumentContent } from '../lib/api'

function mutation(overrides = {}) {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, ...overrides }
}

const HOUSEHOLDS = {
  households: [
    { id: 'h1', name: 'Keluarga Putri', role: 'owner', member_count: 3, is_active: true },
  ],
}

// The two-mode roster (ahaqqu/RumaQ#398): a linked account and a profile-only
// toddler — both must be visible to the vault.
const MEMBERS = {
  members: [
    {
      id: 'm-linked',
      user_id: 'u1',
      has_account: true,
      role: 'owner',
      display_name: null,
      birth_date: null,
      joined_at: '2026-11-01 00:00:00',
      name: 'Alice',
      email: 'alice@example.com',
      picture: null,
    },
    {
      id: 'm-toddler',
      user_id: null,
      has_account: false,
      role: 'member',
      display_name: 'Adik',
      birth_date: '2025-03-02',
      joined_at: '2026-11-02 00:00:00',
      name: null,
      email: null,
      picture: null,
    },
  ],
}

const DOC = {
  id: 'doc-1',
  household_id: 'h1',
  member_id: 'm-toddler',
  category: 'akta',
  file_name: 'akta-adik.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  sha256: 'a'.repeat(64),
  uploaded_by: 'u1',
  created_at: '2026-11-03 10:00:00',
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

function renderDocuments() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(Documents, null)
    )
  )
}

function findButton(container, label) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes(label)
  )
}

function findByAriaLabel(container, label) {
  return container.querySelector(`[aria-label="${label}"]`)
}

// Chips are spans (Household.jsx pattern) — scoped to their labelled group so
// the upload section and the filter section never blur together.
function findChipInGroup(container, groupLabel, chipLabel) {
  const group = container.querySelector(`[role="group"][aria-label="${groupLabel}"]`)
  if (!group) return null
  return [...group.querySelectorAll('span')].find((chip) => chip.textContent.includes(chipLabel))
}

describe('Documents', () => {
  let uploadMutation
  let deleteMutation

  beforeEach(() => {
    vi.clearAllMocks()
    uploadMutation = mutation()
    deleteMutation = mutation()
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useDocuments).mockReturnValue({ data: { documents: [DOC] }, isLoading: false })
    vi.mocked(useUploadDocument).mockReturnValue(uploadMutation)
    vi.mocked(useDeleteDocument).mockReturnValue(deleteMutation)
    vi.mocked(fetchDocumentContent).mockResolvedValue(new Blob(['%PDF-1.7']))
  })

  it('shows the vault identity card, the roster-backed member select (both modes), and the list', () => {
    const { container } = renderDocuments()
    expect(container.textContent).toContain('documents.title')
    expect(container.textContent).toContain('documents.count')
    expect(container.textContent).toContain('akta-adik.pdf')
    // The member select lists BOTH modes; the toddler is labelled no-account.
    const select = container.querySelector('select')
    const options = [...select.querySelectorAll('option')].map((o) => o.textContent)
    expect(options.some((text) => text.includes('Alice'))).toBe(true)
    expect(options.some((text) => text.includes('Adik'))).toBe(true)
    expect(options.some((text) => text.includes('documents.noAccountShort'))).toBe(true)
  })

  it('uploads through the picker + category chips, and the client-side pre-check blocks oversize files before any request', () => {
    const { container } = renderDocuments()
    const input = container.querySelector('input[type="file"]')

    // Oversize: 10 MB + 1 — rejected client-side, no mutate call.
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1).fill(0x00)], 'huge.jpg', {
      type: 'image/jpeg',
    })
    fireEvent.change(input, { target: { files: [big] } })
    expect(container.querySelector('[data-testid="picked-file"]').textContent).toContain('huge.jpg')
    fireEvent.click(findChipInGroup(container, 'documents.categoryLabel', 'documents.category.ktp'))
    fireEvent.click(findButton(container, 'documents.uploadAction'))
    expect(container.textContent).toContain('documents.errorTooLarge')
    expect(uploadMutation.mutate).not.toHaveBeenCalled()

    // A valid file + category reaches the mutation with the exact payload.
    const small = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'ktp.jpg', {
      type: 'image/jpeg',
    })
    fireEvent.change(input, { target: { files: [small] } })
    fireEvent.click(findButton(container, 'documents.uploadAction'))
    expect(uploadMutation.mutate).toHaveBeenCalledTimes(1)
    const [payload] = uploadMutation.mutate.mock.calls[0]
    expect(payload.category).toBe('ktp')
    expect(payload.file.name).toBe('ktp.jpg')

    // Upload success surfaces the feedback line.
    uploadMutation.mutate.mock.calls[0][1].onSuccess({
      document: { file_name: 'ktp.jpg' },
    })
    return waitFor(() => expect(container.textContent).toContain('documents.uploaded'))
  })

  it('requires a category before upload', () => {
    const { container } = renderDocuments()
    const input = container.querySelector('input[type="file"]')
    const small = new File([new Uint8Array([0xff, 0xd8])], 'ktp.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [small] } })
    fireEvent.click(findButton(container, 'documents.uploadAction'))
    expect(container.textContent).toContain('documents.errorNoCategory')
    expect(uploadMutation.mutate).not.toHaveBeenCalled()
  })

  it('attaches a document to a member via the upload select (memberId rides the payload)', () => {
    const { container } = renderDocuments()
    const input = container.querySelector('input[type="file"]')
    const small = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'akta.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(input, { target: { files: [small] } })
    const select = container.querySelector('select')
    fireEvent.change(select, { target: { value: 'm-toddler' } })
    fireEvent.click(
      findChipInGroup(container, 'documents.categoryLabel', 'documents.category.akta')
    )
    fireEvent.click(findButton(container, 'documents.uploadAction'))
    expect(uploadMutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'akta', memberId: 'm-toddler' }),
      expect.anything()
    )
  })

  it('filters the list by category chip and re-queries with the filter', () => {
    const { container } = renderDocuments()
    const chip = findChipInGroup(container, 'documents.filterCategory', 'documents.category.akta')
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chip)
    const lastCall = vi.mocked(useDocuments).mock.calls.at(-1)
    expect(lastCall[0]).toMatchObject({ category: 'akta', memberId: undefined })
  })

  it('previews in-app through an authed inline fetch and revokes the object URL on close', async () => {
    const { container } = renderDocuments()
    const viewButton = findByAriaLabel(container, 'documents.view')
    fireEvent.click(viewButton)
    await waitFor(() => expect(fetchDocumentContent).toHaveBeenCalledWith('doc-1', 'inline'))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    // The dialog is up with the viewer busy/loaded state.
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    fireEvent.click(findByAriaLabel(container, 'documents.closeViewer'))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('manages the viewer dialog focus: enters on open, closes on Escape, restores on close (review B2)', async () => {
    const { container } = renderDocuments()
    const viewButton = findByAriaLabel(container, 'documents.view')
    // jsdom does not move focus on click; a real browser has the button
    // focused when the dialog opens.
    viewButton.focus()
    fireEvent.click(viewButton)
    const dialog = await waitFor(() => {
      const el = container.querySelector('[role="dialog"]')
      expect(el).toBeTruthy()
      return el
    })
    // Focus entered the panel when it opened (AppShell drawer contract).
    expect(dialog.contains(document.activeElement)).toBe(true)
    // Escape closes it; focus hands back to the button that opened it.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(viewButton)
  })

  it('downloads with the attachment disposition (audited as a download server-side)', async () => {
    const { container } = renderDocuments()
    fireEvent.click(findByAriaLabel(container, 'documents.download'))
    await waitFor(() => expect(fetchDocumentContent).toHaveBeenCalledWith('doc-1', 'attachment'))
  })

  it('deletes with a two-step inline confirm (no window.prompt)', () => {
    const { container } = renderDocuments()
    fireEvent.click(findByAriaLabel(container, 'documents.delete'))
    // First click only reveals the confirm — nothing deleted yet.
    expect(deleteMutation.mutate).not.toHaveBeenCalled()
    expect(container.textContent).toContain('documents.deleteConfirmYes')
    fireEvent.click(findButton(container, 'documents.deleteConfirmYes'))
    expect(deleteMutation.mutate).toHaveBeenCalledWith({ id: 'doc-1' }, expect.anything())
  })

  it('shows the empty state when the vault has no documents', () => {
    vi.mocked(useDocuments).mockReturnValue({ data: { documents: [] }, isLoading: false })
    const { container } = renderDocuments()
    expect(container.textContent).toContain('documents.emptyTitle')
    expect(container.textContent).toContain('documents.emptyDesc')
  })
})
