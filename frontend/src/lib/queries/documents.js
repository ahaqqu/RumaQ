import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getDocuments, uploadDocument, deleteDocument } from '../api'

// The document vault (ahaqqu/RumaQ#388 MVP) — server-state for the
// household-scoped document list. The filter pair rides in the query key, so
// switching category/member chips re-fetches against the scoped endpoint
// (server-side filtering — the list stays honest for large vaults).

const DOCUMENTS_KEY = ['documents']

export function documentsQueryKey(filters = {}) {
  const { memberId, category } = filters
  return [DOCUMENTS_KEY[0], { memberId: memberId ?? null, category: category ?? null }]
}

export function useDocuments(filters = {}) {
  const { memberId, category } = filters
  return useQuery({
    queryKey: documentsQueryKey({ memberId, category }),
    queryFn: ({ signal }) => getDocuments({ memberId, category }, signal),
    staleTime: 1000 * 30,
  })
}

// Upload invalidates the whole documents cache (every filter combination can
// gain the new row). The caller surfaces validation errors (413/415/400) from
// the mutation's error — the backend owns the rules.
export function useUploadDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ file, category, memberId }) => uploadDocument(file, category, memberId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY })
    },
  })
}

// Hard delete (server removes object + row together). Same whole-cache
// invalidation: the deleted document may have been visible under several
// filter views.
export function useDeleteDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }) => deleteDocument(id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY })
    },
  })
}
