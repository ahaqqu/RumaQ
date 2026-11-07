import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveProductAlias,
  getAdminProduct,
  getDuplicateProductNames,
  rejectProductAlias,
  renameProduct,
  revertProductRename,
} from '../api'

// Admin canonical product identity and its two writes (ahaqqu/RumaQ#423, PR C).
// The identity is a query of its own — not a slice of ['prices'] — because the
// rename form needs the authoritative `metadataVersion` it must echo back, and
// the public price list has no concept of the audit trail.

export const PRODUCT_IDENTITY_BASE_KEY = ['product-identity']

// Read-only duplicate-name report (#485): a catalog-wide admin read, not a
// slice of one product's identity, so it gets its own key.
export const DUPLICATE_PRODUCT_NAMES_QUERY_KEY = ['product-duplicates']

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

// Every canonical write moves the same three surfaces: the product's own
// identity (the new name + appended audit row, or a flipped alias status), the
// public price lists whose rows carry the name, and the match review queue
// whose canonical entry column shows it.
function useCanonicalWriteInvalidator() {
  const queryClient = useQueryClient()
  return (productKey) => {
    queryClient.invalidateQueries({ queryKey: ['prices'] })
    queryClient.invalidateQueries({ queryKey: productIdentityQueryKey(productKey) })
    queryClient.invalidateQueries({ queryKey: ['review'] })
    // The duplicate report (#485) can gain/lose a group when a name moves.
    queryClient.invalidateQueries({ queryKey: DUPLICATE_PRODUCT_NAMES_QUERY_KEY })
  }
}

// The committed alias is written into the identity cache before the
// invalidated refetch lands, so the row's status chip flips from candidate to
// approved/rejected without a frame of stale state (the rename seeding
// precedent above). The identity query is the only cache that carries aliases.
function seedDecidedAlias(queryClient, productKey, decidedAlias) {
  if (!decidedAlias?.id) return
  queryClient.setQueryData(productIdentityQueryKey(productKey), (previous) => {
    if (!previous?.aliases) return previous
    return {
      ...previous,
      aliases: previous.aliases.map((alias) =>
        alias.id === decidedAlias.id
          ? { ...alias, status: decidedAlias.status ?? alias.status }
          : alias
      ),
    }
  })
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

// Candidate-alias decisions (ahaqqu/RumaQ#489). The decision is addressed by
// the alias id the identity payload carries; the returned alias is seeded into
// the identity cache and the three canonical surfaces re-read. Note what the
// hook does NOT touch: `price_products.metadata_version`, because an alias
// decision changes no canonical field (the backend's own rule) — so a rename
// and an alias decision never race for the same optimistic version.
export function useDecideAlias() {
  const queryClient = useQueryClient()
  const invalidate = useCanonicalWriteInvalidator()
  return useMutation({
    mutationFn: ({ productKey, aliasId, action }) => {
      if (action === 'approve') return approveProductAlias(productKey, aliasId)
      if (action === 'reject') return rejectProductAlias(productKey, aliasId)
      // The routes accept exactly two verbs. Never default an unknown one to a
      // decision: a reject is terminal and must only happen on purpose.
      return Promise.reject(new Error(`Unknown alias decision '${action}'`))
    },
    onSuccess: (result, variables) => {
      seedDecidedAlias(queryClient, variables.productKey, result?.alias)
      invalidate(variables.productKey)
    },
  })
}

// Read-only duplicate-name report (ahaqqu/RumaQ#485). A rename/revert (or an
// alias approval) can move it, so the canonical writes invalidate it alongside
// ['prices']. Lazy on purpose: the Products page mounts the panel behind the admin's
// "show report" action, so neither a shopper nor an admin's first paint pays
// for the report.
export function useDuplicateProductNames({ enabled = true } = {}) {
  return useQuery({
    queryKey: DUPLICATE_PRODUCT_NAMES_QUERY_KEY,
    queryFn: ({ signal }) => getDuplicateProductNames(signal),
    enabled,
  })
}
