import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import {
  getMe,
  getStock,
  getHealth,
  login,
  logout,
  isAuthenticated,
  emailAuthStatus,
  emailLogin,
  getSettings,
  patchSettings,
  getLocations,
  createLocation,
  deleteLocation,
  getItems,
  getStores,
  createStore,
  deleteStore,
  getAiUsage,
  patchStock,
  getHome,
  scanReceipt,
  createPurchase,
  getReceiptUrl,
  getPurchases,
  getPurchasePatterns,
  getPurchase,
  sendChatMessage,
  getPlans,
  getAiProviders,
  testAiProvider,
  generatePlan,
  savePlan,
  createDocument,
  addDocumentFile,
  updatePlanItem,
  getAdminProduct,
  getDuplicateProductNames,
  renameProduct,
  revertProductRename,
  approveProductAlias,
  rejectProductAlias,
  getReviewMode,
  setReviewMode,
  evaluateReviewItems,
  decideReviewItem,
} from './api'

// The client is mocked at the generated hey-api client boundary: these tests
// cover the wrapper contract (paths, params, error mapping), while the client
// owns URL building and response parsing. Assertions spell out the header (and
// the multipart serializer) the generated SDK attaches, so the full call shape
// stays pinned.
const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    delete: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    setConfig: vi.fn(),
  },
}))

vi.mock('./api-client/client.gen.js', () => ({
  client: clientMock,
}))

// The response stub models the real fetch Response surface unwrap() reads —
// status/ok plus the headers it inspects (Retry-After on 429s).
const ok = (data) => ({
  data,
  error: undefined,
  response: { ok: true, status: 200, headers: { get: () => null } },
})
const fail = (error, status = 500) => ({
  data: undefined,
  error,
  response: { ok: false, status, headers: { get: () => null } },
})

beforeEach(() => {
  clientMock.get.mockReset()
  clientMock.post.mockReset()
  clientMock.put.mockReset()
  clientMock.patch.mockReset()
  clientMock.delete.mockReset()
})

describe('api', () => {
  it('getMe calls /api/me', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ user: { id: '1', email: 'a@b.com' } }))
    const result = await getMe()
    expect(result).toEqual({ user: { id: '1', email: 'a@b.com' } })
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/me' })
  })

  it('getStock without params', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ stock: [] }))
    const result = await getStock()
    expect(result).toEqual({ stock: [] })
    expect(clientMock.get).toHaveBeenCalledWith({
      url: '/api/stock',
      query: { location: undefined, q: undefined },
      signal: undefined,
    })
  })

  it('getStock with location and q params', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ stock: [] }))
    await getStock({ location: 'kulkas', q: 'susu' })
    expect(clientMock.get).toHaveBeenCalledWith({
      url: '/api/stock',
      query: { location: 'kulkas', q: 'susu' },
      signal: undefined,
    })
  })

  it('getHealth calls /api/health', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ ok: true }))
    const result = await getHealth()
    expect(result).toEqual({ ok: true })
  })

  it('throws on failed request', async () => {
    clientMock.get.mockResolvedValueOnce(fail({ error: 'Server error' }, 500))
    await expect(getMe()).rejects.toThrow('Server error')
  })

  it('throws fallback message when body has no error property', async () => {
    clientMock.get.mockResolvedValueOnce(fail({}, 504))
    await expect(getMe()).rejects.toThrow('Request failed: 504')
  })

  it('throws ApiError carrying the response status', async () => {
    clientMock.get.mockResolvedValueOnce(fail({ error: 'Unauthorized' }, 401))
    await expect(getMe()).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      message: 'Unauthorized',
    })
  })

  it('carries the Retry-After seconds a 429 sent (T4-B6)', async () => {
    clientMock.get.mockResolvedValueOnce({
      data: undefined,
      error: { error: 'Too many OCR requests. Please slow down.' },
      response: { ok: false, status: 429, headers: { get: () => '45' } },
    })
    await expect(getMe()).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      retryAfterSeconds: 45,
    })
  })

  it('degrades a missing or non-numeric Retry-After to null, not a crash', async () => {
    clientMock.get.mockResolvedValueOnce({
      data: undefined,
      error: { error: 'Too many uploads.' },
      response: { ok: false, status: 429, headers: { get: () => 'Wed, 21 Oct 2026 07:28:00 GMT' } },
    })
    await expect(getMe()).rejects.toMatchObject({ status: 429, retryAfterSeconds: null })
  })

  it('login constructs correct redirect URL', () => {
    const origLocation = window.location
    const setter = vi.fn()
    const mockLocation = {}
    Object.defineProperty(mockLocation, 'href', { set: setter, get: () => '' })
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      configurable: true,
      writable: true,
    })
    login()
    expect(setter).toHaveBeenCalledWith(expect.stringContaining('/api/auth/login'))
    Object.defineProperty(window, 'location', {
      value: origLocation,
      configurable: true,
      writable: true,
    })
  })

  it('logout POSTs /api/auth/logout and then navigates home', async () => {
    // POST, not a GET navigation (ahaqqu/RumaQ#528 review A1): the epoch bump
    // that revokes the token everywhere is guard-covered only on POST, so a
    // cross-site link to the GET route must not be the client's logout.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    })
    const origLocation = window.location
    const setter = vi.fn()
    const mockLocation = {}
    Object.defineProperty(mockLocation, 'href', { set: setter, get: () => '' })
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      configurable: true,
      writable: true,
    })
    await logout()
    const [url, opts] = globalThis.fetch.mock.calls[0]
    expect(url).toBe('/api/auth/logout')
    expect(opts.method).toBe('POST')
    expect(opts.credentials).toBe('include')
    expect(setter).toHaveBeenCalledWith('/')
    Object.defineProperty(window, 'location', {
      value: origLocation,
      configurable: true,
      writable: true,
    })
  })

  it('logout falls back to the GET navigation when the POST fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'))
    const origLocation = window.location
    const setter = vi.fn()
    const mockLocation = {}
    Object.defineProperty(mockLocation, 'href', { set: setter, get: () => '' })
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      configurable: true,
      writable: true,
    })
    await logout()
    expect(setter).toHaveBeenCalledWith('/api/auth/logout')
    Object.defineProperty(window, 'location', {
      value: origLocation,
      configurable: true,
      writable: true,
    })
  })

  it('isAuthenticated returns true when getMe succeeds', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ user: { id: '1' } }))
    expect(await isAuthenticated()).toBe(true)
  })

  it('isAuthenticated returns false when getMe fails', async () => {
    clientMock.get.mockResolvedValueOnce(fail({ error: 'Unauthorized' }, 401))
    expect(await isAuthenticated()).toBe(false)
  })

  it('emailAuthStatus calls /api/auth/email-status', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ enabled: true }))
    const result = await emailAuthStatus()
    expect(result).toEqual({ enabled: true })
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/auth/email-status' })
  })

  it('emailAuthStatus returns disabled on error', async () => {
    clientMock.get.mockResolvedValueOnce(fail({ error: 'fail' }, 500))
    const result = await emailAuthStatus()
    expect(result).toEqual({ enabled: false })
  })

  it('emailLogin posts credentials to /api/auth/email-login', async () => {
    clientMock.post.mockResolvedValueOnce(ok({ ok: true }))
    const result = await emailLogin('test@rumaq.dev', 'password123')
    expect(result).toEqual({ ok: true })
    expect(clientMock.post).toHaveBeenCalledWith({
      url: '/api/auth/email-login',
      body: { email: 'test@rumaq.dev', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('getSettings calls /api/settings', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ motion_preference: 'standard' }))
    const result = await getSettings()
    expect(result).toEqual({ motion_preference: 'standard' })
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/settings' })
  })

  it('patchSettings sends PATCH payload', async () => {
    clientMock.patch.mockResolvedValueOnce(ok({ ok: true }))
    const result = await patchSettings({ language: 'id' })
    expect(result).toEqual({ ok: true })
    expect(clientMock.patch).toHaveBeenCalledWith({
      url: '/api/settings',
      body: { language: 'id' },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('getLocations calls /api/locations', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ locations: [] }))
    const result = await getLocations()
    expect(result).toEqual({ locations: [] })
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/locations' })
  })

  it('createLocation posts label', async () => {
    clientMock.post.mockResolvedValueOnce(ok({ location: { id: 'l1', label: 'Kulkas' } }))
    const result = await createLocation('Kulkas')
    expect(result.location.label).toBe('Kulkas')
    expect(clientMock.post).toHaveBeenCalledWith({
      url: '/api/locations',
      body: { label: 'Kulkas' },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('deleteLocation calls DELETE endpoint', async () => {
    clientMock.delete.mockResolvedValueOnce(ok(null))
    await deleteLocation('l1')
    expect(clientMock.delete).toHaveBeenCalledWith({
      url: '/api/locations/{id}',
      path: { id: 'l1' },
    })
  })

  it('getItems calls /api/items', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ items: [] }))
    const result = await getItems()
    expect(result).toEqual({ items: [] })
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/items' })
  })

  it('getStores calls /api/stores', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ stores: [] }))
    const result = await getStores()
    expect(result).toEqual({ stores: [] })
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/stores' })
  })

  it('createStore posts label', async () => {
    clientMock.post.mockResolvedValueOnce(ok({ store: { id: 's1', label: 'Indomaret' } }))
    const result = await createStore('Indomaret')
    expect(result.store.label).toBe('Indomaret')
    expect(clientMock.post).toHaveBeenCalledWith({
      url: '/api/stores',
      body: { label: 'Indomaret' },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('deleteStore calls DELETE endpoint', async () => {
    clientMock.delete.mockResolvedValueOnce(ok(null))
    await deleteStore('s1')
    expect(clientMock.delete).toHaveBeenCalledWith({ url: '/api/stores/{id}', path: { id: 's1' } })
  })

  it('getAiUsage calls /api/ai/usage', async () => {
    clientMock.get.mockResolvedValueOnce(
      ok({
        used: 5,
        input_tokens: 1200,
        output_tokens: 350,
        cached_tokens: null,
        provider: 'gemini',
        key_source: 'user',
      })
    )
    const result = await getAiUsage()
    expect(result).toEqual({
      used: 5,
      input_tokens: 1200,
      output_tokens: 350,
      cached_tokens: null,
      provider: 'gemini',
      key_source: 'user',
    })
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/ai/usage', signal: undefined })
  })

  // #523 P3: `POST /api/ai-key/test` is retired with the legacy key test. The
  // provider test is per row and its answer is a code, never a body.
  it('testAiProvider posts to the provider row test endpoint', async () => {
    clientMock.post.mockResolvedValueOnce(ok({ ok: false, code: 'auth' }))
    const result = await testAiProvider('p-1')
    expect(result).toEqual({ ok: false, code: 'auth' })
    expect(clientMock.post).toHaveBeenCalledWith({
      url: '/api/ai/providers/{id}/test',
      path: { id: 'p-1' },
    })
  })

  it('never sends the write-only key back to a read endpoint', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ can_manage: true, managed_by: null, providers: [] }))
    await getAiProviders()
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/ai/providers' })
  })

  it('patchStock calls PATCH endpoint', async () => {
    clientMock.patch.mockResolvedValueOnce(ok({ stock: { id: 'x' } }))
    const result = await patchStock('x', { qty: 5 })
    expect(result.stock.id).toBe('x')
    expect(clientMock.patch).toHaveBeenCalledWith({
      url: '/api/stock/{id}',
      path: { id: 'x' },
      body: { qty: 5 },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('getHome calls /api/home', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ total_items: 3 }))
    const result = await getHome()
    expect(result.total_items).toBe(3)
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/home', signal: undefined })
  })

  it('scanReceipt posts FormData', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    })
    const file = new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })
    const result = await scanReceipt(file)
    expect(result).toEqual({ items: [] })
    const [url, opts] = globalThis.fetch.mock.calls[0]
    expect(url).toContain('/api/purchases/scan')
    expect(opts.method).toBe('POST')
    expect(opts.credentials).toBe('include')
    expect(opts.body).toBeInstanceOf(FormData)
  })

  it('scanReceipt throws on error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: 'Invalid image' }),
    })
    const file = new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })
    await expect(scanReceipt(file)).rejects.toThrow('Invalid image')
  })

  it('createPurchase posts payload', async () => {
    clientMock.post.mockResolvedValueOnce(ok({ purchase: { id: 'p1' } }))
    const result = await createPurchase({ items: [{ name: 'A', qty: 1, unit: 'pcs', price: 0 }] })
    expect(result.purchase.id).toBe('p1')
    expect(clientMock.post).toHaveBeenCalledWith({
      url: '/api/purchases',
      body: { items: [{ name: 'A', qty: 1, unit: 'pcs', price: 0 }] },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('getReceiptUrl returns URL', () => {
    expect(getReceiptUrl('p1')).toContain('/api/purchases/p1/receipt')
  })

  it('getPurchases builds query params', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ purchases: [] }))
    await getPurchases({
      store: 's1',
      from: '2026-01-01',
      to: '2026-12-31',
      q: 'milk',
      groupBy: 'month',
      limit: 10,
      cursor: 'c1',
    })
    expect(clientMock.get).toHaveBeenCalledWith({
      url: '/api/purchases',
      query: {
        store: 's1',
        from: '2026-01-01',
        to: '2026-12-31',
        q: 'milk',
        group_by: 'month',
        limit: 10,
        cursor: 'c1',
      },
      signal: undefined,
    })
  })

  it('getPurchasePatterns calls /api/purchases/patterns', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ patterns: [] }))
    const result = await getPurchasePatterns()
    expect(result).toEqual({ patterns: [] })
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/purchases/patterns' })
  })

  it('getPurchase calls /api/purchases/:id', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ purchase: { id: 'p1' } }))
    const result = await getPurchase('p1')
    expect(result.purchase.id).toBe('p1')
    expect(clientMock.get).toHaveBeenCalledWith({ url: '/api/purchases/{id}', path: { id: 'p1' } })
  })

  it('sendChatMessage posts message without history', async () => {
    clientMock.post.mockResolvedValueOnce(ok({ reply: 'hello' }))
    const result = await sendChatMessage('hi')
    expect(result.reply).toBe('hello')
    expect(clientMock.post).toHaveBeenCalledWith({
      url: '/api/ai/chat',
      body: { message: 'hi' },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('sendChatMessage includes history when provided', async () => {
    clientMock.post.mockResolvedValueOnce(ok({ reply: 'ok' }))
    await sendChatMessage('hi', [{ role: 'user', content: 'previous' }])
    expect(clientMock.post).toHaveBeenCalledWith({
      url: '/api/ai/chat',
      body: { message: 'hi', history: [{ role: 'user', content: 'previous' }] },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('getPlans defaults to active', async () => {
    clientMock.get.mockResolvedValueOnce(ok({ plans: [] }))
    await getPlans()
    expect(clientMock.get).toHaveBeenCalledWith({
      url: '/api/plans',
      query: { status: 'active' },
      signal: undefined,
    })
  })

  it('generatePlan posts to /api/plans/generate', async () => {
    clientMock.post.mockResolvedValueOnce(ok({ items: [] }))
    const result = await generatePlan()
    expect(result).toEqual({ items: [] })
    expect(clientMock.post).toHaveBeenCalledWith({ url: '/api/plans/generate' })
  })

  it('savePlan posts items', async () => {
    clientMock.post.mockResolvedValueOnce(ok({ plan: { id: 'pl1' } }))
    const result = await savePlan([{ name: 'A' }])
    expect(result.plan.id).toBe('pl1')
    expect(clientMock.post).toHaveBeenCalledWith({
      url: '/api/plans',
      body: { items: [{ name: 'A' }] },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('updatePlanItem calls PATCH endpoint', async () => {
    clientMock.patch.mockResolvedValueOnce(ok({ item: { id: 'i1' } }))
    const result = await updatePlanItem('pl1', 'i1', 'bought')
    expect(result.item.id).toBe('i1')
    expect(clientMock.patch).toHaveBeenCalledWith({
      url: '/api/plans/{id}/items/{itemId}',
      path: { id: 'pl1', itemId: 'i1' },
      body: { status: 'bought' },
      headers: { 'Content-Type': 'application/json' },
    })
  })

  describe('document uploads (multipart)', () => {
    it('createDocument hands the multipart fields to the generated serializer', async () => {
      clientMock.post.mockResolvedValueOnce(ok({ document: { id: 'doc-1' } }))
      const file = new File(['receipt'], 'receipt.jpg', { type: 'image/jpeg' })
      await createDocument({ name: 'Receipt', file, label: 'warranty', memberId: 'm1' })
      // A plain object, never a pre-built FormData: the client's multipart
      // serializer reads own enumerable entries, and FormData has none — a
      // FormData body would silently upload an empty form.
      expect(clientMock.post).toHaveBeenCalledWith({
        url: '/api/documents',
        body: { name: 'Receipt', file, label: 'warranty', memberId: 'm1' },
        // Multipart ops carry the serializer that turns the plain object into
        // FormData (and drop Content-Type so the boundary is set by fetch).
        bodySerializer: expect.any(Function),
        headers: { 'Content-Type': null },
      })
    })

    it('addDocumentFile posts the file and optional label', async () => {
      clientMock.post.mockResolvedValueOnce(ok({ file: { id: 'f1' } }))
      const file = new File(['page'], 'page.png', { type: 'image/png' })
      await addDocumentFile('doc-1', file, 'page 1')
      expect(clientMock.post).toHaveBeenCalledWith({
        url: '/api/documents/{id}/files',
        path: { id: 'doc-1' },
        body: { file, label: 'page 1' },
        bodySerializer: expect.any(Function),
        headers: { 'Content-Type': null },
      })
    })
  })

  describe('admin canonical products (#423)', () => {
    const identity = {
      product: { productKey: 'minyak--bimoli--1-l', name: 'Minyak Bimoli', metadataVersion: 3 },
      aliases: [],
      stats: { observations: 4, stores: 2 },
      audit: [],
    }

    it('getAdminProduct reads the identity for a product key', async () => {
      clientMock.get.mockResolvedValueOnce(ok(identity))
      await expect(getAdminProduct('minyak--bimoli--1-l')).resolves.toEqual(identity)
      expect(clientMock.get).toHaveBeenCalledWith({
        url: '/api/admin/products/{productKey}',
        path: { productKey: 'minyak--bimoli--1-l' },
        signal: undefined,
      })
    })

    it('getDuplicateProductNames reads the case-insensitive duplicate report', async () => {
      const report = {
        limit: 200,
        truncated: false,
        groups: [
          {
            normalizedName: 'beras ramos 5 kg',
            displayName: 'Beras Ramos 5 kg',
            productCount: 2,
            products: [],
          },
        ],
      }
      clientMock.get.mockResolvedValueOnce(ok(report))
      await expect(getDuplicateProductNames()).resolves.toEqual(report)
      // The report is a static path, not the identity route's {productKey}.
      expect(clientMock.get).toHaveBeenCalledWith({
        url: '/api/admin/products/duplicates',
        signal: undefined,
      })
    })

    it('renameProduct posts the optimistic version and the acknowledgement flag', async () => {
      clientMock.post.mockResolvedValueOnce(
        ok({ product: { name: 'Minyak Goreng Bimoli' }, warnings: [], audit: [], indexVersion: 7 })
      )
      const result = await renameProduct('k', {
        canonicalName: 'Minyak Goreng Bimoli',
        expectedMetadataVersion: 3,
        reason: 'wrong label',
        acknowledgeWarnings: true,
      })
      expect(result.indexVersion).toBe(7)
      expect(clientMock.post).toHaveBeenCalledWith({
        url: '/api/admin/products/{productKey}/rename',
        path: { productKey: 'k' },
        body: {
          canonicalName: 'Minyak Goreng Bimoli',
          expectedMetadataVersion: 3,
          reason: 'wrong label',
          acknowledgeWarnings: true,
        },
        headers: { 'Content-Type': 'application/json' },
      })
    })

    it('revertProductRename addresses the audit row with an empty body by default', async () => {
      clientMock.post.mockResolvedValueOnce(
        ok({ product: { name: 'Minyak Bimoli' }, warnings: [], audit: [], indexVersion: 8 })
      )
      await revertProductRename('k', 'audit-1')
      expect(clientMock.post).toHaveBeenCalledWith({
        url: '/api/admin/products/{productKey}/audit/{auditId}/revert',
        path: { productKey: 'k', auditId: 'audit-1' },
        body: {},
        headers: { 'Content-Type': 'application/json' },
      })
    })

    it('carries the structured rename 409 body on ApiError.body', async () => {
      const conflicts = [{ productKey: 'other', name: 'Minyak Bimoli', source: 'product' }]
      clientMock.post.mockResolvedValueOnce(fail({ error: 'duplicate_name', conflicts }, 409))
      await expect(
        renameProduct('k', { canonicalName: 'Minyak Bimoli', expectedMetadataVersion: 3 })
      ).rejects.toMatchObject({
        name: 'ApiError',
        status: 409,
        message: 'duplicate_name',
        body: { error: 'duplicate_name', conflicts },
      })
    })

    // Candidate-alias decisions (#489, PR 2): the alias id is the whole
    // request — no body — and the decision is the route verb.
    it('approveProductAlias posts to the alias approve route with both path ids', async () => {
      clientMock.post.mockResolvedValueOnce(
        ok({ alias: { id: 'alias-1', status: 'approved' }, indexVersion: 17 })
      )
      const result = await approveProductAlias('minyak--bimoli--1-l', 'alias-1')
      expect(result.indexVersion).toBe(17)
      expect(clientMock.post).toHaveBeenCalledWith({
        url: '/api/admin/products/{productKey}/aliases/{aliasId}/approve',
        path: { productKey: 'minyak--bimoli--1-l', aliasId: 'alias-1' },
      })
    })

    it('rejectProductAlias posts to the alias reject route with both path ids', async () => {
      clientMock.post.mockResolvedValueOnce(
        ok({ alias: { id: 'alias-2', status: 'rejected' }, indexVersion: 17 })
      )
      await rejectProductAlias('k', 'alias-2')
      expect(clientMock.post).toHaveBeenCalledWith({
        url: '/api/admin/products/{productKey}/aliases/{aliasId}/reject',
        path: { productKey: 'k', aliasId: 'alias-2' },
      })
    })

    it('carries the alias_state 409 body on ApiError.body', async () => {
      clientMock.post.mockResolvedValueOnce(
        fail({ error: 'alias_state', currentStatus: 'approved' }, 409)
      )
      await expect(approveProductAlias('k', 'alias-1')).rejects.toMatchObject({
        name: 'ApiError',
        status: 409,
        message: 'alias_state',
        body: { error: 'alias_state', currentStatus: 'approved' },
      })
    })
  })

  describe('AI review (issue #484)', () => {
    it('getReviewMode calls the admin mode route', async () => {
      clientMock.get.mockResolvedValueOnce(ok({ mode: 'assist', aiConfigured: true }))
      const result = await getReviewMode()
      expect(clientMock.get).toHaveBeenCalledWith({
        url: '/api/admin/review/mode',
        signal: undefined,
      })
      expect(result).toEqual({ mode: 'assist', aiConfigured: true })
    })

    it('setReviewMode PUTs the chosen mode', async () => {
      clientMock.put.mockResolvedValueOnce(ok({ mode: 'auto', aiConfigured: true }))
      const result = await setReviewMode('auto')
      expect(clientMock.put).toHaveBeenCalledWith({
        url: '/api/admin/review/mode',
        body: { mode: 'auto' },
        headers: { 'Content-Type': 'application/json' },
      })
      expect(result).toEqual({ mode: 'auto', aiConfigured: true })
    })

    it('evaluateReviewItems POSTs the bounded limit', async () => {
      clientMock.post.mockResolvedValueOnce(
        ok({ evaluated: 5, applied: 0, mode: 'assist', aiConfigured: true })
      )
      const result = await evaluateReviewItems(5)
      expect(clientMock.post).toHaveBeenCalledWith({
        url: '/api/admin/review/evaluate',
        body: { limit: 5 },
        headers: { 'Content-Type': 'application/json' },
      })
      expect(result.evaluated).toBe(5)
    })

    it('decideReviewItem sends agreement only when one is given', async () => {
      clientMock.post.mockResolvedValue(ok({ item: { id: 'rev-1' } }))
      await decideReviewItem('rev-1', 'approved')
      expect(clientMock.post).toHaveBeenLastCalledWith({
        url: '/api/admin/review/{id}/decision',
        path: { id: 'rev-1' },
        body: { decision: 'approved' },
        headers: { 'Content-Type': 'application/json' },
      })
      await decideReviewItem('rev-1', 'rejected', 'disagreed')
      expect(clientMock.post).toHaveBeenLastCalledWith({
        url: '/api/admin/review/{id}/decision',
        path: { id: 'rev-1' },
        body: { decision: 'rejected', agreement: 'disagreed' },
        headers: { 'Content-Type': 'application/json' },
      })
    })
  })
})
