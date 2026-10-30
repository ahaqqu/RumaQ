import { expect } from 'vite-plus/test'
import { resetDb, seedDb } from '../../../support/db.js'
import { signTestCookie } from '../../../support/auth.js'

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'
const TEST_USER_ID = process.env.TEST_USER_ID || 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

// Each test file / scenario gets a stable but unique synthetic IP so the
// in-memory rate limiter treats them as separate clients. This avoids
// one scenario exhausting the global window for the entire suite.
let ipCounter = 0
function makeTestIp() {
  ipCounter += 1
  // Spread across the 10.0.0.0/8 range to stay well clear of real networks.
  const b = (ipCounter >> 16) & 0xff
  const c = (ipCounter >> 8) & 0xff
  const d = ipCounter & 0xff
  return `10.${b}.${c}.${d}`
}

export class ApiContext {
  constructor() {
    this.response = null
    this.responseBody = null
    const testIp = makeTestIp()
    this.headers = {
      'X-Forwarded-For': testIp,
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'localhost:3000',
      'X-Forwarded-Port': '3000',
    }
  }

  get defaultHeaders() {
    return this.headers
  }

  get baseUrl() {
    return BASE_URL
  }

  get testUserId() {
    return TEST_USER_ID
  }

  async resetAndSeed() {
    await resetDb()
    await seedDb()
  }

  async authenticate() {
    const cookie = await signTestCookie(TEST_USER_ID, {
      email: 'test@rumaq.dev',
    })
    this.headers = { ...this.headers, Cookie: cookie }
  }

  async authenticateViaEmail(email, password) {
    this.response = await fetch(`${BASE_URL}/api/auth/email-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    try {
      this.responseBody = await this.response.json()
    } catch {
      this.responseBody = null
    }
    const setCookie = this.response.headers.get('set-cookie')
    if (setCookie) {
      this.headers = { ...this.headers, Cookie: setCookie.split(';')[0] }
    }
  }

  async sendRequest(method, path) {
    const opts = { method }
    if (this.headers) opts.headers = this.headers
    this.response = await fetch(`${BASE_URL}${path}`, opts)
    try {
      this.responseBody = await this.response.json()
    } catch {
      this.responseBody = null
    }
  }

  expectStatus(code) {
    // Issue #318: a status-only assertion hides the error body ({error: ...})
    // that explains an unexpected 500 from the harness cold start. Include a
    // bounded snippet; full bodies can be large list payloads.
    const body = JSON.stringify(this.responseBody) ?? 'null'
    const snippet = body.length > 300 ? `${body.slice(0, 300)}...(truncated)` : body
    expect(this.response.status, `response body: ${snippet}`).toBe(code)
  }

  expectBodyToMatch(expected) {
    expect(this.responseBody).toMatchObject(expected)
  }

  expectPublicCacheHeaders() {
    const cc = this.response.headers.get('Cache-Control') || ''
    expect(cc).toMatch(/public/)
    expect(cc).toMatch(/max-age=60/)
  }

  expectAuthenticatedCacheHeaders() {
    const cc = this.response.headers.get('Cache-Control') || ''
    expect(cc).toMatch(/private, no-cache/)
  }

  expectStockArray() {
    expect(Array.isArray(this.responseBody?.stock)).toBe(true)
  }

  expectStockLength(n) {
    expect(this.responseBody.stock).toHaveLength(n)
  }

  expectItemShape() {
    for (const item of this.responseBody.stock) {
      expect(item).toHaveProperty('id')
      expect(item).toHaveProperty('name')
      expect(item).toHaveProperty('qty')
      expect(item).toHaveProperty('unit')
      expect(item).toHaveProperty('location')
    }
  }

  expectUserShape() {
    expect(this.responseBody.user).toBeDefined()
    expect(this.responseBody.user.id).toBe(TEST_USER_ID)
    expect(this.responseBody.user.email).toBe('test@rumaq.dev')
    expect(this.responseBody.user.name).toBe('Test User')
  }

  expectNamedFirstItem(name) {
    expect(this.responseBody.stock[0].name).toBe(name)
  }

  expectOrderedByRunOutDays() {
    const runOutDays = this.responseBody.stock.map((s) => s.run_out_days).filter(Boolean)
    expect(runOutDays).toEqual([3, 7, 14])
  }

  async sendRequestWithBody(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } }
    if (this.headers) opts.headers = { ...opts.headers, ...this.headers }
    if (body != null) opts.body = JSON.stringify(body)
    this.response = await fetch(`${BASE_URL}${path}`, opts)
    try {
      this.responseBody = await this.response.json()
    } catch {
      this.responseBody = null
    }
  }

  async sendRequestDirect(method, path, body) {
    const opts = { method }
    if (this.headers) opts.headers = this.headers
    if (body != null) {
      opts.headers = { ...opts.headers, 'Content-Type': 'application/json' }
      opts.body = JSON.stringify(body)
    }
    this.response = await fetch(`${BASE_URL}${path}`, opts)
    try {
      this.responseBody = await this.response.json()
    } catch {
      this.responseBody = null
    }
  }

  expectSettingsShape() {
    expect(this.responseBody).toHaveProperty('motion_preference')
    expect(this.responseBody).toHaveProperty('has_ai_key')
  }

  expectHasAiKey(value) {
    expect(this.responseBody.has_ai_key).toBe(value)
  }

  expectSetting(field, value) {
    expect(this.responseBody[field]).toBe(value)
  }

  expectNoAiKeyInResponse() {
    expect(this.responseBody).not.toHaveProperty('encrypted_ai_key')
    expect(this.responseBody).not.toHaveProperty('ai_key')
  }

  expectLocationsArray() {
    expect(Array.isArray(this.responseBody?.locations)).toBe(true)
  }

  expectLocationsLength(n) {
    expect(this.responseBody.locations).toHaveLength(n)
  }

  expectCreatedLocationLabel(label) {
    expect(this.responseBody.location).toBeDefined()
    expect(this.responseBody.location.label).toBe(label)
  }

  expectStoresArray() {
    expect(Array.isArray(this.responseBody?.stores)).toBe(true)
  }

  expectStoresLength(n) {
    expect(this.responseBody.stores).toHaveLength(n)
  }

  expectCreatedStoreLabel(label) {
    expect(this.responseBody.store).toBeDefined()
    expect(this.responseBody.store.label).toBe(label)
  }

  expectUsageDefaults() {
    expect(this.responseBody).toHaveProperty('used')
    expect(this.responseBody).toHaveProperty('daily_limit')
    expect(this.responseBody.used).toBe(0)
    expect(this.responseBody.daily_limit).toBe(20)
  }

  expectStockUpdatedQty(qty) {
    expect(this.responseBody.stock).toBeDefined()
    expect(this.responseBody.stock.qty).toBe(qty)
  }

  expectStockRunOutComputed() {
    expect(this.responseBody.stock).toBeDefined()
    expect(this.responseBody.stock).toHaveProperty('run_out_days')
    expect(this.responseBody.stock).toHaveProperty('basis')
  }

  expectHomeShape() {
    expect(this.responseBody).toHaveProperty('total_items')
    expect(this.responseBody).toHaveProperty('expiring_7d')
    expect(this.responseBody).toHaveProperty('running_out_7d')
    expect(this.responseBody).toHaveProperty('low_stock')
    expect(this.responseBody).toHaveProperty('next_trip')
  }

  expectHomeTotalItems(n) {
    expect(this.responseBody.total_items).toBe(n)
  }

  expectHomeExpiring7d(n) {
    expect(this.responseBody.expiring_7d).toBe(n)
  }

  expectHomeRunningOutItems() {
    expect(this.responseBody.running_out_7d).toBeGreaterThan(0)
  }

  expectLowStockArray() {
    expect(Array.isArray(this.responseBody.low_stock)).toBe(true)
  }

  expectLowStockLength(n) {
    expect(this.responseBody.low_stock.length).toBeGreaterThanOrEqual(n)
  }

  expectLowStockItemShape() {
    for (const item of this.responseBody.low_stock) {
      expect(item).toHaveProperty('id')
      expect(item).toHaveProperty('name')
      expect(item).toHaveProperty('qty')
      expect(item).toHaveProperty('unit')
      expect(item).toHaveProperty('location')
    }
  }

  async sendMultipart(method, path, fieldName, fileContent, fileName, fileType) {
    const formData = new FormData()
    const blob = new Blob([fileContent], { type: fileType })
    formData.append(fieldName, blob, fileName)
    const opts = { method, body: formData }
    if (this.headers) opts.headers = { ...this.headers }
    this.response = await fetch(`${BASE_URL}${path}`, opts)
    try {
      this.responseBody = await this.response.json()
    } catch {
      this.responseBody = null
    }
  }

  expectScanItems() {
    expect(this.responseBody).toHaveProperty('items')
    expect(Array.isArray(this.responseBody.items)).toBe(true)
    expect(this.responseBody.items.length).toBeGreaterThan(0)
  }

  expectImageKey() {
    expect(this.responseBody).toHaveProperty('imageKey')
    expect(this.responseBody.imageKey).toBeTruthy()
  }

  expectStoreGuess(label) {
    expect(this.responseBody).toHaveProperty('storeGuess')
    expect(this.responseBody.storeGuess).toBeTruthy()
    expect(this.responseBody.storeGuess.label).toBe(label)
  }

  expectPurchaseShape() {
    expect(this.responseBody).toHaveProperty('purchase')
    expect(this.responseBody.purchase).toHaveProperty('id')
    expect(this.responseBody.purchase).toHaveProperty('date')
  }

  expectItemsArray() {
    expect(this.responseBody).toHaveProperty('items')
    expect(Array.isArray(this.responseBody.items)).toBe(true)
  }

  expectStockForItem(name, qty) {
    const item = this.responseBody.stock.find((s) => s.name.toLowerCase() === name.toLowerCase())
    expect(item).toBeDefined()
    expect(item.qty).toBe(qty)
  }

  expectPurchasesArray() {
    expect(Array.isArray(this.responseBody?.purchases)).toBe(true)
  }

  expectEachPurchaseHasItems() {
    for (const p of this.responseBody.purchases) {
      expect(p).toHaveProperty('items')
      expect(Array.isArray(p.items)).toBe(true)
    }
  }

  expectMonthTotals() {
    expect(this.responseBody).toHaveProperty('month_totals')
    expect(Array.isArray(this.responseBody.month_totals)).toBe(true)
  }

  expectAvgPerMonth() {
    expect(this.responseBody).toHaveProperty('avg_per_month')
    expect(typeof this.responseBody.avg_per_month).toBe('number')
  }

  expectSeedPurchasesInList() {
    const ids = this.responseBody.purchases.map((p) => p.id)
    expect(ids).toContain('purch-1')
    expect(ids).toContain('purch-2')
    expect(ids).toContain('purch-3')
  }

  expectAllPurchasesFromStore(label) {
    for (const p of this.responseBody.purchases) {
      expect(p.store_label).toBe(label)
    }
  }

  expectAllPurchasesInDateRange(from, to) {
    for (const p of this.responseBody.purchases) {
      expect(p.date >= from && p.date <= to).toBe(true)
    }
  }

  expectPurchasesContainItem(name) {
    const allItems = this.responseBody.purchases.flatMap((p) => p.items.map((i) => i.name))
    expect(allItems.filter(Boolean)).toContain(name)
  }

  expectPurchaseDetail(id) {
    expect(this.responseBody).toHaveProperty('purchase')
    expect(this.responseBody.purchase.id).toBe(id)
  }

  expectPurchaseDetailHasItems() {
    expect(this.responseBody).toHaveProperty('items')
    expect(Array.isArray(this.responseBody.items)).toBe(true)
    expect(this.responseBody.items.length).toBeGreaterThan(0)
  }

  expectPatternsArray() {
    expect(Array.isArray(this.responseBody?.patterns)).toBe(true)
  }

  expectPatternContains(name) {
    const names = this.responseBody.patterns.map((p) => p.name)
    expect(names).toContain(name)
  }

  expectChatReply() {
    expect(this.responseBody).toHaveProperty('reply')
    expect(typeof this.responseBody.reply).toBe('string')
    expect(this.responseBody.reply.length).toBeGreaterThan(0)
  }
}
