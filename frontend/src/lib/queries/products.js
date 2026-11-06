import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getAdminProduct, renameProduct, revertProductRename } from '../api'

// Admin canonical product identity and its two writes (ahaqqu/RumaQ#423, PR C).
// The identity is a query of its own — not a slice of ['prices'] — because the
// rename form needs the authoritative `metadataVersion` it must echo back, and
// the public price list has no concept of the audit trail.

export const PRODUCT_IDENTITY_BASE_KEY = ['product-identity']

export function productIdentityQueryKey(productKey) {
  return [...PRODUCT_IDENTITY_BASE_KEY, productKey ?? null]
}

// Mounted by the rename form — which both admin surfaces keep collapsed
// behind their action, so a shopper (or an admin browsing) never fires it —
// and `enabled` additionally guards a missing key. No staleTime: the
// optimistic `expectedMetadataVersion` must come from the newest read, and the
// `stale_product` path is what re-syncs a stale one.
export function useProductIdentity(productKey, { enabled = true } = {}) {
  return useQuery({
    queryKey: productIdentityQueryKey(productKey),
    queryFn: ({ signal }) => getAdminProduct(productKey, signal),
    enabled: enabled && Boolean(productKey),
  })
}

// Both canonical writes move the same three surfaces: the product's own
// identity (the new name + appended audit row), the public price lists whose
// rows carry the name, and the match review queue whose canonical entry column
// shows it.
function useCanonicalWriteInvalidator() {
  const queryClient = useQueryClient()
  return (productKey) => {
    queryClient.invalidateQueries({ queryKey: ['prices'] })
    queryClient.invalidateQueries({ queryKey: productIdentityQueryKey(productKey) })
    queryClient.invalidateQueries({ queryKey: ['review'] })
  }
}

// The committed row is written into the identity cache before the invalidated
// refetch lands, so the open form never flashes the old name (or the previous
// audit tail) between success and the re-read.
function useSeedIdentityFromMutationResult() {
  const queryClient = useQueryClient()
  const invalidate = useCanonicalWriteInvalidator()
  return (productKey, result) => {
    if (result) {
      queryClient.setQueryData(productIdentityQueryKey(productKey), (previous) =>
        previous?.product ? { ...previous, product: result.product, audit: result.audit } : previous
      )
    }
    invalidate(productKey)
  }
}

export function useRenameProduct() {
  const seed = useSeedIdentityFromMutationResult()
  return useMutation({
    mutationFn: ({ productKey, ...body }) => renameProduct(productKey, body),
    onSuccess: (result, variables) => seed(variables.productKey, result),
  })
}

export function useRevertRename() {
  const seed = useSeedIdentityFromMutationResult()
  return useMutation({
    mutationFn: ({ productKey, auditId, ...body }) =>
      revertProductRename(productKey, auditId, body),
    onSuccess: (result, variables) => seed(variables.productKey, result),
  })
}
