import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  useDocuments,
  useUploadDocument,
  useDeleteDocument,
  documentsQueryKey,
} from './documents.js'
import { getDocuments, uploadDocument, deleteDocument } from '../api'

vi.mock('../api', () => ({
  getDocuments: vi.fn(),
  uploadDocument: vi.fn(),
  deleteDocument: vi.fn(),
}))

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

const DOC = {
  id: 'doc-1',
  household_id: 'h1',
  member_id: null,
  category: 'akta',
  file_name: 'akta-adik.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  sha256: 'a'.repeat(64),
  uploaded_by: 'u1',
  created_at: '2026-11-03 10:00:00',
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
      { memberId: undefined, category: undefined },
      expect.anything()
    )
  })

  it('keys and fetches per filter pair — member and category ride the key', async () => {
    getDocuments.mockResolvedValue({ documents: [] })
    const { result, rerender } = renderHook(({ filters }) => useDocuments(filters), {
      wrapper: createWrapper(queryClient),
      initialProps: { filters: { memberId: 'm-toddler' } },
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getDocuments).toHaveBeenCalledWith(
      { memberId: 'm-toddler', category: undefined },
      expect.anything()
    )
    expect(documentsQueryKey({ memberId: 'm-toddler' })).toEqual([
      'documents',
      { memberId: 'm-toddler', category: null },
    ])
    expect(documentsQueryKey({ category: 'akta' })).not.toEqual(
      documentsQueryKey({ memberId: 'm-toddler' })
    )
    void rerender
  })
})

describe('useUploadDocument', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['documents', { memberId: null, category: null }], {
      documents: [],
    })
    vi.clearAllMocks()
  })

  it('uploads with the picked file/category/member and invalidates the vault cache on settle', async () => {
    uploadDocument.mockResolvedValue({ document: DOC })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'ktp.jpg', {
      type: 'image/jpeg',
    })

    const { result } = renderHook(() => useUploadDocument(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ file, category: 'ktp', memberId: 'm-toddler' }))

    expect(uploadDocument).toHaveBeenCalledWith(file, 'ktp', 'm-toddler')
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['documents'] })
      )
    )
  })

  it('invalidates even when the upload fails (415/413 surfaces via error)', async () => {
    uploadDocument.mockRejectedValue(new Error('415'))
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const file = new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' })

    const { result } = renderHook(() => useUploadDocument(), {
      wrapper: createWrapper(queryClient),
    })
    await act(async () => result.current.mutate({ file, category: 'ktp' }))

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
