import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useDecideAlias, productIdentityQueryKey } from './products.js'
import { approveProductAlias, rejectProductAlias } from '../api'

vi.mock('../api', () => ({
  getAdminProduct: vi.fn(),
  renameProduct: vi.fn(),
  revertProductRename: vi.fn(),
  approveProductAlias: vi.fn(),
  rejectProductAlias: vi.fn(),
}))

function createWrapper(queryClient) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

const identity = {
  product: { productKey: 'beras-ramos-5kg--ramos--5-kg', name: 'Beras Ramos', metadataVersion: 3 },
  aliases: [
    { id: 'alias-1', name: 'Beras Ramos 5 kg', storeSlug: 'lotte-mart', status: 'candidate' },
    { id: 'alias-2', name: 'Ramos 5 KG', storeSlug: 'alfamart', status: 'candidate' },
  ],
  stats: { observations: 4, stores: 2 },
  audit: [],
}

// Candidate-alias decisions (#489, PR 2): the hook is the seam between the
// decision routes and the three caches the alias list lives in.
describe('useDecideAlias', () => {
  let queryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.clearAllMocks()
  })

  it('approves by product key + alias id and seeds the decided alias', async () => {
    approveProductAlias.mockResolvedValue({
      alias: { id: 'alias-1', status: 'approved' },
      indexVersion: 17,
    })
    queryClient.setQueryData(productIdentityQueryKey('k'), identity)
    const { result } = renderHook(() => useDecideAlias(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.mutateAsync({
        productKey: 'k',
        aliasId: 'alias-1',
        action: 'approve',
      })
    })

    expect(approveProductAlias).toHaveBeenCalledWith('k', 'alias-1')
    // The decided row flips immediately; the other candidate is untouched.
    const seeded = queryClient.getQueryData(productIdentityQueryKey('k'))
    expect(seeded.aliases.map((alias) => alias.status)).toEqual(['approved', 'candidate'])
    expect(seeded.aliases.map((alias) => alias.id)).toEqual(['alias-1', 'alias-2'])
  })

  it('invalidates the identity, the price lists and the review queue', async () => {
    approveProductAlias.mockResolvedValue({
      alias: { id: 'alias-1', status: 'approved' },
      indexVersion: 17,
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useDecideAlias(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.mutateAsync({
        productKey: 'k',
        aliasId: 'alias-1',
        action: 'approve',
      })
    })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['prices'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: productIdentityQueryKey('k') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['review'] })
  })

  it('routes a reject to the reject route and never calls approve', async () => {
    rejectProductAlias.mockResolvedValue({
      alias: { id: 'alias-2', status: 'rejected' },
      indexVersion: 12,
    })
    const { result } = renderHook(() => useDecideAlias(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.mutateAsync({ productKey: 'k', aliasId: 'alias-2', action: 'reject' })
    })
    expect(rejectProductAlias).toHaveBeenCalledWith('k', 'alias-2')
    expect(approveProductAlias).not.toHaveBeenCalled()
  })

  it('does not invalidate anything when the decision is refused', async () => {
    rejectProductAlias.mockRejectedValue(new Error('alias_state'))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useDecideAlias(), {
      wrapper: createWrapper(queryClient),
    })

    // A 409 alias_state is a refusal: the caches keep what they had and the
    // form's own refetch is the recovery path, not a speculative invalidation.
    await act(async () => {
      await expect(
        result.current.mutateAsync({ productKey: 'k', aliasId: 'alias-2', action: 'reject' })
      ).rejects.toThrow('alias_state')
    })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refuses an unknown decision verb instead of defaulting to one', async () => {
    const { result } = renderHook(() => useDecideAlias(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await expect(
        result.current.mutateAsync({ productKey: 'k', aliasId: 'alias-1', action: 'maybe' })
      ).rejects.toThrow("Unknown alias decision 'maybe'")
    })
    // A reject is terminal: an unknown verb must never be treated as one.
    expect(approveProductAlias).not.toHaveBeenCalled()
    expect(rejectProductAlias).not.toHaveBeenCalled()
  })
})
