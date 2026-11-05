import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  useDocuments,
  useCreateDocument,
  useAddDocumentFile,
  useDeleteDocument,
  useDeleteDocumentFile,
  useUpdateDocumentExpiry,
  documentsQueryKey,
} from './documents.js'
import {
  getDocuments,
  createDocument,
  addDocumentFile,
  deleteDocument,
  deleteDocumentFile,
  updateDocumentExpiry,
} from '../api'

vi.mock('../api', () => ({
  getDocuments: vi.fn(),
  createDocument: vi.fn(),
  addDocumentFile: vi.fn(),
  deleteDocument: vi.fn(),
  deleteDocumentFile: vi.fn(),
  updateDocumentExpiry: vi.fn(),
}))

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

const DOC = {
  id: 'doc-1',
  household_id: 'h1',
  member_id: null,
  name: 'KTP Adik',
  uploaded_by: 'u1',
  created_at: '2026-11-03 10:00:00',
  files: [],
}

describe('useDocuments', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.clearAllMocks()
  })

  it('fetches unfiltered by default and exposes the documents list', async () => {
    getDocuments.mockResolvedValue({ documents: [DOC] })
    const { result } = renderHook(() => useDocuments(), {
      wrapper: createWrapper(queryClient),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data.documents).toHaveLength(1)
    expect(getDocuments).toHaveBeenCalledWith(
      { q: undefined, memberId: undefined },
      expect.anything()
    )
  })

  it('keys and fetches per filter pair — the q name search and member ride the key (#422)', async () => {
    getDocuments.mockResolvedValue({ documents: [] })
    const { result } = renderHook(({ filters }) => useDocuments(filters), {
      wrapper: createWrapper(queryClient),
      initialProps: { filters: { q: 'ktp' } },
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getDocuments).toHaveBeenCalledWith(
      { q: 'ktp', memberId: undefined, expiringWithin: undefined },
      expect.anything()
    )
    expect(documentsQueryKey({ q: 'ktp' })).toEqual([
      'documents',
      { q: 'ktp', memberId: null, expiringWithin: null },
    ])
    expect(documentsQueryKey({ q: 'ktp' })).not.toEqual(documentsQueryKey({ q: 'akta' }))
    expect(documentsQueryKey({ memberId: 'm-1' })).not.toEqual(documentsQueryKey({ q: 'ktp' }))
  })

  it('keys and fetches per expiring_within window — a distinct filter dimension (#426)', async () => {
    getDocuments.mockResolvedValue({ documents: [] })
    const { result } = renderHook(({ filters }) => useDocuments(filters), {
      wrapper: createWrapper(queryClient),
      initialProps: { filters: { expiringWithin: 30 } },
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // The window rides the query as the snake_case param the API takes.
    expect(getDocuments).toHaveBeenCalledWith(
      { q: undefined, memberId: undefined, expiringWithin: 30 },
      expect.anything()
    )
    expect(documentsQueryKey({ expiringWithin: 30 })).toEqual([
      'documents',
      { q: null, memberId: null, expiringWithin: 30 },
    ])
    expect(documentsQueryKey({ expiringWithin: 30 })).not.toEqual(
      documentsQueryKey({ expiringWithin: 7 })
    )
    expect(documentsQueryKey({ expiringWithin: 30 })).not.toEqual(documentsQueryKey({}))
  })
})

describe('useCreateDocument', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['documents', { q: null, memberId: null }], { documents: [] })
    vi.clearAllMocks()
  })

  it('creates with name + first file (+ optional label/member) and invalidates the vault cache on settle', async () => {
    createDocument.mockResolvedValue({ document: DOC })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'ktp.jpg', {
      type: 'image/jpeg',
    })

    const { result } = renderHook(() => useCreateDocument(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () =>
      result.current.mutate({
        name: 'KTP',
        file,
        label: 'Depan',
        memberId: 'm-toddler',
      })
    )

    expect(createDocument).toHaveBeenCalledWith({
      name: 'KTP',
      file,
      label: 'Depan',
      memberId: 'm-toddler',
    })
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['documents'] })
      )
    )
  })

  it('invalidates even when the create fails (413/415/400 surfaces via error)', async () => {
    createDocument.mockRejectedValue(new Error('415'))
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const file = new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' })

    const { result } = renderHook(() => useCreateDocument(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ name: 'KTP', file }))

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['documents'] })
      )
    )
  })
})

describe('useAddDocumentFile', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.clearAllMocks()
  })

  // Review B3 #422: the hook does NOT invalidate per settle — an N-file
  // upload would refetch the whole list N times. The page's upload runner
  // invalidates ONCE after the loop; this pins the hook's no-invalidate side.
  it('adds a file and leaves cache invalidation to the caller (no per-settle refetch)', async () => {
    addDocumentFile.mockResolvedValue({ document: DOC })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'belakang.jpg', {
      type: 'image/jpeg',
    })

    const { result } = renderHook(() => useAddDocumentFile(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ documentId: 'doc-1', file, label: 'Belakang' }))

    expect(addDocumentFile).toHaveBeenCalledWith('doc-1', file, 'Belakang')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})

describe('useDeleteDocument', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.clearAllMocks()
  })

  it('deletes by id and invalidates the vault cache', async () => {
    deleteDocument.mockResolvedValue(null)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useDeleteDocument(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 'doc-1' }))

    expect(deleteDocument).toHaveBeenCalledWith('doc-1')
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['documents'] })
      )
    )
  })
})

describe('useDeleteDocumentFile', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.clearAllMocks()
  })

  it('deletes one file off its document and invalidates the vault cache', async () => {
    deleteDocumentFile.mockResolvedValue(null)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useDeleteDocumentFile(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ documentId: 'doc-1', fileId: 'file-1' }))

    expect(deleteDocumentFile).toHaveBeenCalledWith('doc-1', 'file-1')
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['documents'] })
      )
    )
  })
})

describe('useUpdateDocumentExpiry', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.clearAllMocks()
  })

  it('sends the expiry payload for its document and invalidates the vault cache', async () => {
    updateDocumentExpiry.mockResolvedValue({ document: DOC })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useUpdateDocumentExpiry(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () =>
      result.current.mutate({
        id: 'doc-1',
        payload: { expires_on: '2027-01-01', remind_days_before: 14 },
      })
    )

    expect(updateDocumentExpiry).toHaveBeenCalledWith('doc-1', {
      expires_on: '2027-01-01',
      remind_days_before: 14,
    })
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['documents'] })
      )
    )
  })

  it('sends the clearing payload (expires_on null) and still invalidates on settle', async () => {
    updateDocumentExpiry.mockResolvedValue({ document: DOC })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useUpdateDocumentExpiry(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ id: 'doc-1', payload: { expires_on: null } }))

    expect(updateDocumentExpiry).toHaveBeenCalledWith('doc-1', { expires_on: null })
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['documents'] })
      )
    )
  })
})
