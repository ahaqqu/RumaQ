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
  useCreateDocument: vi.fn(),
  useAddDocumentFile: vi.fn(),
  useDeleteDocument: vi.fn(),
  useDeleteDocumentFile: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(message, status) {
      super(message)
      this.status = status
    }
  },
  DOCUMENT_MAX_BYTES: 10 * 1024 * 1024,
  DOCUMENT_MAX_FILES: 20,
  DOCUMENT_NAME_MAX: 120,
  fetchDocumentContent: vi.fn(),
}))

import { useMe } from '../lib/queries/me.js'
import {
  useHouseholds,
  useHouseholdMembers,
  useDocuments,
  useCreateDocument,
  useAddDocumentFile,
  useDeleteDocument,
  useDeleteDocumentFile,
} from '../lib/queries/index.js'
import { fetchDocumentContent, DOCUMENT_MAX_FILES } from '../lib/api'

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

const FILE = {
  id: 'file-1',
  document_id: 'doc-1',
  file_name: 'depan.jpg',
  content_type: 'image/jpeg',
  size_bytes: 1024,
  label: 'Depan',
  sort_order: 1,
  sha256: 'a'.repeat(64),
  uploaded_by: 'u1',
  uploaded_at: '2026-11-03 10:00:00',
}

const DOC = {
  id: 'doc-1',
  household_id: 'h1',
  member_id: 'm-toddler',
  name: 'KTP Adik',
  uploaded_by: 'u1',
  created_at: '2026-11-03 10:00:00',
  files: [FILE],
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

function pickedFileNames(container) {
  return [...container.querySelectorAll('[data-testid="picked-file"]')].map((el) =>
    el.textContent.split(' · ')[0]
  )
}

function pickFiles(container, input, files) {
  fireEvent.change(input, { target: { files } })
}

function jpegFile(name, size = 10) {
  return new File([new Uint8Array(size).fill(0x00)], name, { type: 'image/jpeg' })
}

describe('Documents', () => {
  let createMutation
  let addFileMutation
  let deleteMutation
  let deleteFileMutation

  beforeEach(() => {
    vi.clearAllMocks()
    createMutation = mutation()
    addFileMutation = mutation()
    deleteMutation = mutation()
    deleteFileMutation = mutation()
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useDocuments).mockReturnValue({ data: { documents: [DOC] }, isLoading: false })
    vi.mocked(useCreateDocument).mockReturnValue(createMutation)
    vi.mocked(useAddDocumentFile).mockReturnValue(addFileMutation)
    vi.mocked(useDeleteDocument).mockReturnValue(deleteMutation)
    vi.mocked(useDeleteDocumentFile).mockReturnValue(deleteFileMutation)
    vi.mocked(fetchDocumentContent).mockResolvedValue(new Blob(['%PDF-1.7']))
  })

  it('shows the vault identity card, the roster-backed member select (both modes), and the list with files + labels', () => {
    const { container } = renderDocuments()
    expect(container.textContent).toContain('documents.title')
    expect(container.textContent).toContain('documents.count')
    // Free-text document name in the list; the file under it with its label.
    expect(container.textContent).toContain('KTP Adik')
    expect(container.textContent).toContain('depan.jpg')
    expect(container.textContent).toContain('Depan')
    // No preset category chips anywhere (owner directive #422).
    expect(container.textContent).not.toContain('documents.categoryLabel')
    // The member select lists BOTH modes; the toddler is labelled no-account.
    const select = container.querySelector('select')
    const options = [...select.querySelectorAll('option')].map((o) => o.textContent)
    expect(options.some((text) => text.includes('Alice'))).toBe(true)
    expect(options.some((text) => text.includes('Adik'))).toBe(true)
    expect(options.some((text) => text.includes('documents.noAccountShort'))).toBe(true)
  })

  it('requires a name before upload — free text, no preset list (#422)', async () => {
    const { container } = renderDocuments()
    const input = container.querySelector('input[type="file"]')
    pickFiles(container, input, [jpegFile('ktp.jpg')])
    fireEvent.click(findButton(container, 'documents.uploadAction'))
    expect(container.textContent).toContain('documents.errorNoName')
    expect(createMutation.mutateAsync).not.toHaveBeenCalled()
  })

  it('keeps the upload action disabled until files are picked', async () => {
    const { container } = renderDocuments()
    const nameInput = container.querySelector('[data-testid="document-name"]')
    fireEvent.change(nameInput, { target: { value: 'Kartu Keluarga' } })
    const uploadButton = findButton(container, 'documents.uploadAction')
    expect(uploadButton.disabled).toBe(true)
    expect(createMutation.mutateAsync).not.toHaveBeenCalled()
  })

  it('blocks oversize files client-side before any request (10 MB cap)', async () => {
    const { container } = renderDocuments()
    const nameInput = container.querySelector('[data-testid="document-name"]')
    fireEvent.change(nameInput, { target: { value: 'Scan besar' } })
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1).fill(0x00)], 'huge.jpg', {
      type: 'image/jpeg',
    })
    pickFiles(container, container.querySelector('input[type="file"]'), [big])
    fireEvent.click(findButton(container, 'documents.uploadAction'))
    expect(container.textContent).toContain('documents.errorTooLarge')
    expect(createMutation.mutateAsync).not.toHaveBeenCalled()
  })

  it('creates with the first file, then rides the rest through add-file in pick order (labels included)', async () => {
    createMutation.mutateAsync.mockResolvedValue({ document: { id: 'doc-new' } })
    addFileMutation.mutateAsync.mockResolvedValue({ document: { id: 'doc-new' } })
    const { container } = renderDocuments()

    const nameInput = container.querySelector('[data-testid="document-name"]')
    fireEvent.change(nameInput, { target: { value: '  Buku Nika  ' } })
    const input = container.querySelector('input[type="file"]')
    pickFiles(container, input, [jpegFile('page-1.jpg'), jpegFile('page-2.jpg'), jpegFile('page-3.jpg')])

    // Optional per-file labels ride their file (owner decision #422-1).
    const labelInputs = [...container.querySelectorAll('[aria-label^="documents.labelAria"]')]
    expect(labelInputs).toHaveLength(3)
    fireEvent.change(labelInputs[0], { target: { value: 'Halaman depan' } })
    fireEvent.change(labelInputs[2], { target: { value: 'Halaman 3' } })

    fireEvent.click(findButton(container, 'documents.uploadAction'))

    await waitFor(() => expect(createMutation.mutateAsync).toHaveBeenCalledTimes(1))
    // The create takes the free-text name (trimmed) + the FIRST file.
    expect(createMutation.mutateAsync.mock.calls[0][0]).toMatchObject({
      name: 'Buku Nika',
      label: 'Halaman depan',
      memberId: undefined,
    })
    expect(createMutation.mutateAsync.mock.calls[0][0].file.name).toBe('page-1.jpg')

    // The remaining files ride add-file sequentially, in pick order.
    await waitFor(() => expect(addFileMutation.mutateAsync).toHaveBeenCalledTimes(2))
    expect(addFileMutation.mutateAsync.mock.calls[0][0]).toMatchObject({
      documentId: 'doc-new',
      label: undefined,
    })
    expect(addFileMutation.mutateAsync.mock.calls[0][0].file.name).toBe('page-2.jpg')
    expect(addFileMutation.mutateAsync.mock.calls[1][0]).toMatchObject({
      documentId: 'doc-new',
      label: 'Halaman 3',
    })
    expect(addFileMutation.mutateAsync.mock.calls[1][0].file.name).toBe('page-3.jpg')

    // Success surfaces the feedback line with the document name.
    await waitFor(() => expect(container.textContent).toContain('documents.uploaded'))
    // The picked list clears.
    expect(pickedFileNames(container)).toEqual([])
  })

  it('attaches a document to a member via the upload select (memberId rides the create payload)', async () => {
    createMutation.mutateAsync.mockResolvedValue({ document: { id: 'doc-new' } })
    const { container } = renderDocuments()
    const nameInput = container.querySelector('[data-testid="document-name"]')
    fireEvent.change(nameInput, { target: { value: 'Akta Adik' } })
    pickFiles(container, container.querySelector('input[type="file"]'), [jpegFile('akta.jpg')])
    const select = container.querySelector('select')
    fireEvent.change(select, { target: { value: 'm-toddler' } })
    fireEvent.click(findButton(container, 'documents.uploadAction'))
    await waitFor(() => expect(createMutation.mutateAsync).toHaveBeenCalled())
    expect(createMutation.mutateAsync.mock.calls[0][0]).toMatchObject({
      name: 'Akta Adik',
      memberId: 'm-toddler',
    })
  })

  it('searches by name: the search input rides the query key (no category filter anymore)', () => {
    const { container } = renderDocuments()
    const search = container.querySelector('[data-testid="document-search"]')
    expect(search).toBeTruthy()
    fireEvent.change(search, { target: { value: '  ktp  ' } })
    const lastCall = vi.mocked(useDocuments).mock.calls.at(-1)
    // Trimmed q + no memberId — the name search, not a category picklist.
    expect(lastCall[0]).toMatchObject({ q: 'ktp', memberId: undefined })
  })

  it('filters the list by member chip and re-queries with the filter', () => {
    const { container } = renderDocuments()
    const chip = [...container.querySelectorAll('button[aria-pressed]')].find((b) =>
      b.textContent.includes('Alice')
    )
    fireEvent.click(chip)
    const lastCall = vi.mocked(useDocuments).mock.calls.at(-1)
    expect(lastCall[0]).toMatchObject({ memberId: 'm-linked', q: undefined })
  })

  it('previews a file in-app through an authed per-file inline fetch and revokes the object URL on close', async () => {
    const { container } = renderDocuments()
    const viewButton = findByAriaLabel(container, 'documents.view: depan.jpg')
    fireEvent.click(viewButton)
    await waitFor(() => expect(fetchDocumentContent).toHaveBeenCalledWith('doc-1', 'file-1', 'inline'))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    // The dialog is up with the viewer busy/loaded state, labelled by the file.
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog.getAttribute('aria-label')).toBe('depan.jpg')
    fireEvent.click(findByAriaLabel(container, 'documents.closeViewer'))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('manages the viewer dialog focus: enters on open, closes on Escape, restores on close (review B2)', async () => {
    const { container } = renderDocuments()
    const viewButton = findByAriaLabel(container, 'documents.view: depan.jpg')
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

  it('downloads with the attachment disposition through the per-file endpoint (audited server-side)', async () => {
    const { container } = renderDocuments()
    fireEvent.click(findByAriaLabel(container, 'documents.download: depan.jpg'))
    await waitFor(() =>
      expect(fetchDocumentContent).toHaveBeenCalledWith('doc-1', 'file-1', 'attachment')
    )
  })

  it('deletes ONE file with a two-step inline confirm (no window.prompt)', async () => {
    const { container } = renderDocuments()
    fireEvent.click(findByAriaLabel(container, 'documents.deleteFile: depan.jpg'))
    // First click only reveals the confirm — nothing deleted yet.
    expect(deleteFileMutation.mutate).not.toHaveBeenCalled()
    expect(container.textContent).toContain('documents.deleteConfirmYes')
    fireEvent.click(findButton(container, 'documents.deleteConfirmYes'))
    expect(deleteFileMutation.mutate).toHaveBeenCalledWith(
      { documentId: 'doc-1', fileId: 'file-1' },
      expect.anything()
    )
  })

  it('deletes the whole document with a two-step inline confirm', () => {
    const { container } = renderDocuments()
    fireEvent.click(findByAriaLabel(container, 'documents.delete: KTP Adik'))
    expect(deleteMutation.mutate).not.toHaveBeenCalled()
    fireEvent.click(findButton(container, 'documents.deleteConfirmYes'))
    expect(deleteMutation.mutate).toHaveBeenCalledWith({ id: 'doc-1' }, expect.anything())
  })

  it('adds files to an existing document sequentially, and refuses going past the 20-file cap client-side', async () => {
    addFileMutation.mutateAsync.mockResolvedValue({ document: { id: 'doc-1' } })
    const { container } = renderDocuments()
    fireEvent.click(findByAriaLabel(container, 'documents.add files') ?? findButton(container, 'documents.addFiles'))

    // The add-files form replaces the row.
    expect(container.textContent).toContain('documents.addFilesTitle')
    const addInput = [...container.querySelectorAll('input[type="file"]')][1]
    pickFiles(container, addInput, [jpegFile('belakang.jpg')])
    const labelInput = container.querySelector('[aria-label^="documents.labelAria"]')
    fireEvent.change(labelInput, { target: { value: 'Belakang' } })
    fireEvent.click(findButton(container, 'documents.addFilesAction'))

    await waitFor(() => expect(addFileMutation.mutateAsync).toHaveBeenCalledTimes(1))
    expect(addFileMutation.mutateAsync.mock.calls[0][0]).toMatchObject({
      documentId: 'doc-1',
      label: 'Belakang',
    })
    expect(addFileMutation.mutateAsync.mock.calls[0][0].file.name).toBe('belakang.jpg')
    await waitFor(() => expect(container.textContent).toContain('documents.filesAdded'))

    // A full document (20 files) refuses more — client pre-check, no call.
    vi.mocked(useDocuments).mockReturnValue({
      data: { documents: [{ ...DOC, files: Array.from({ length: DOCUMENT_MAX_FILES }, (_, i) => ({ ...FILE, id: `f-${i}` })) }] },
      isLoading: false,
    })
    const { container: full } = renderDocuments()
    const addButtons = [...full.querySelectorAll('button')].filter((b) =>
      b.textContent.includes('documents.addFiles')
    )
    expect(addButtons[0]?.disabled).toBe(true)
  })

  it('shows the empty state when the vault has no documents', () => {
    vi.mocked(useDocuments).mockReturnValue({ data: { documents: [] }, isLoading: false })
    const { container } = renderDocuments()
    expect(container.textContent).toContain('documents.emptyTitle')
    expect(container.textContent).toContain('documents.emptyDesc')
  })
})
