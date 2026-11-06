import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getDocuments,
  createDocument,
  addDocumentFile,
  deleteDocument,
  deleteDocumentFile,
  updateDocumentExpiry,
  extractDocumentExpiry,
} from '../api'

// The document vault (ahaqqu/RumaQ#422 rework) — server-state for the
// household-scoped document list. The filter trio (q = free-text name search,
// memberId, expiringWithin = the #426 expiry window) rides in the query key,
// so changing any re-fetches against the scoped endpoint (server-side
// filtering — the list stays honest for large vaults).

const DOCUMENTS_KEY = ['documents']

// The BARE base key for invalidations (review delta D1 #422): react-query
// prefix-matches array keys, so invalidating ['documents'] reaches EVERY
// filtered view. Invalidating documentsQueryKey() instead would be one exact
// filter object ({ q: null, memberId: null }) — an active search or member
// filter would NOT match it and its list would go stale.
export const DOCUMENTS_BASE_KEY = DOCUMENTS_KEY

export function documentsQueryKey(filters = {}) {
  const { q, memberId, expiringWithin } = filters
  return [
    DOCUMENTS_KEY[0],
    { q: q ?? null, memberId: memberId ?? null, expiringWithin: expiringWithin ?? null },
  ]
}

export function useDocuments(filters = {}) {
  const { q, memberId, expiringWithin } = filters
  return useQuery({
    queryKey: documentsQueryKey({ q, memberId, expiringWithin }),
    queryFn: ({ signal }) => getDocuments({ q, memberId, expiringWithin }, signal),
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
// document payload (all files) is what the endpoint answers with. NO per-settle
// invalidation here (review B3 #422): each settle fired a whole-cache
// invalidate, so an N-file upload refetched the list ~N times — the page's
// upload runner invalidates ONCE after the loop finishes instead.
export function useAddDocumentFile() {
  return useMutation({
    mutationFn: ({ documentId, file, label }) => addDocumentFile(documentId, file, label),
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

// Expiry metadata update (#426). Same whole-cache invalidation: the edited
// document may be visible under several filter views (and the computed
// days_until_expiry changes for every one of them).
export function useUpdateDocumentExpiry() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }) => updateDocumentExpiry(id, payload),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: DOCUMENTS_KEY })
    },
  })
}

// Expiry-date OCR (#433): an explicit per-file "Read date" action against the
// USER'S OWN AI provider (the backend resolves the vision model). NO cache
// invalidation — this is a pure read over stored bytes, and its answer is a
// SUGGESTION the page holds in form state; the vault cache only changes when
// the user confirms through useUpdateDocumentExpiry above.
export function useExtractDocumentExpiry() {
  return useMutation({
    mutationFn: ({ documentId, fileId }) => extractDocumentExpiry(documentId, fileId),
  })
}
