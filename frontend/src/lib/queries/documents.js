import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getDocuments,
  createDocument,
  addDocumentFile,
  deleteDocument,
  deleteDocumentFile,
} from '../api'

// The document vault (ahaqqu/RumaQ#422 rework) — server-state for the
// household-scoped document list. The filter pair (q = free-text name search,
// memberId) rides in the query key, so changing either re-fetches against the
// scoped endpoint (server-side filtering — the list stays honest for large
// vaults).

const DOCUMENTS_KEY = ['documents']

export function documentsQueryKey(filters = {}) {
  const { q, memberId } = filters
  return [DOCUMENTS_KEY[0], { q: q ?? null, memberId: memberId ?? null }]
}

export function useDocuments(filters = {}) {
  const { q, memberId } = filters
  return useQuery({
    queryKey: documentsQueryKey({ q, memberId }),
    queryFn: ({ signal }) => getDocuments({ q, memberId }, signal),
    staleTime: 1000 * 30,
  })
}

// Create = name + first file. Every cache view can gain the new row, so the
// whole documents cache invalidates on settle — the caller surfaces
// validation errors (413/415/400) from the mutation's error; the backend owns
// the rules.
export function useCreateDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ name, file, label, memberId }) =>
      createDocument({ name, file, label, memberId }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY })
    },
  })
}

// Add a file to an existing document. The create-then-N-adds loop in the page
// awaits each mutation so upload order stays deterministic; the returned
// document payload (all files) is what the endpoint answers with.
export function useAddDocumentFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, file, label }) => addDocumentFile(documentId, file, label),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY })
    },
  })
}

// Hard delete (server removes every file object + the rows together). Same
// whole-cache invalidation: the deleted document may have been visible under
// several filter views.
export function useDeleteDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }) => deleteDocument(id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY })
    },
  })
}

export function useDeleteDocumentFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, fileId }) => deleteDocumentFile(documentId, fileId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY })
    },
  })
}
