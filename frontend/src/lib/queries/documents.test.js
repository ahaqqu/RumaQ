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
  documentsQueryKey,
} from './documents.js'
import {
  getDocuments,
  createDocument,
  addDocumentFile,
  deleteDocument,
  deleteDocumentFile,
} from '../api'

vi.mock('../api', () => ({
  getDocuments: vi.fn(),
  createDocument: vi.fn(),
  addDocumentFile: vi.fn(),
  deleteDocument: vi.fn(),
  deleteDocumentFile: vi.fn(),
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
      { q: 'ktp', memberId: undefined },
      expect.anything()
    )
    expect(documentsQueryKey({ q: 'ktp' })).toEqual([
      'documents',
      { q: 'ktp', memberId: null },
    ])
    expect(documentsQueryKey({ q: 'ktp' })).not.toEqual(documentsQueryKey({ q: 'akta' }))
    expect(documentsQueryKey({ memberId: 'm-1' })).not.toEqual(documentsQueryKey({ q: 'ktp' }))
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

  it('adds a file to the document and invalidates the vault cache', async () => {
    addDocumentFile.mockResolvedValue({ document: DOC })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'belakang.jpg', {
      type: 'image/jpeg',
    })

    const { result } = renderHook(() => useAddDocumentFile(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () =>
      result.current.mutate({ documentId: 'doc-1', file, label: 'Belakang' })
    )

    expect(addDocumentFile).toHaveBeenCalledWith('doc-1', file, 'Belakang')
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['documents'] })
      )
    )
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
