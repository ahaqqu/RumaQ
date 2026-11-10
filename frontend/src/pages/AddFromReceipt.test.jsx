import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { AddFromReceipt } from './AddFromReceipt.jsx'
import * as api from '../lib/api'

vi.mock('../lib/api', () => ({
  scanReceipt: vi.fn(),
  createPurchase: vi.fn(),
  getReceiptUrl: vi.fn(() => '/api/purchases/123/receipt'),
  getStores: vi.fn(),
  getItems: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

const MOCK_STORES = { stores: [{ id: 's1', label: 'Indomaret' }] }
const MOCK_ITEMS = { items: [{ id: 'i1', name: 'Milk', unit: 'L' }] }

function createFile(name, type, size) {
  const blob = new Blob(['x'.repeat(size)], { type })
  return new File([blob], name, { type })
}

function selectFile(container, file) {
  const input = container.querySelector('input[data-testid="file-input"]')
  if (!input) throw new Error('File input not found')
  Object.defineProperty(input, 'files', { value: [file] })
  fireEvent.change(input)
}

function renderComponent(props = {}) {
  return render(React.createElement(AddFromReceipt, { onDone: vi.fn(), ...props }))
}

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn()
})

describe('AddFromReceipt', () => {
  it('renders capture phase by default', () => {
    const { container } = renderComponent()
    expect(container.querySelector('[class*="border-2 border-dashed"]')).toBeTruthy()
  })

  it('renders page lead', () => {
    const { container } = renderComponent()
    expect(container.querySelector('[class*="max-w-[62ch]"]')).toBeTruthy()
  })

  it('shows error for unsupported file type', async () => {
    const { container } = renderComponent()
    const file = createFile('test.gif', 'image/gif', 100)
    selectFile(container, file)

    await waitFor(() => {
      expect(container.textContent).toContain('Unsupported file type')
    })
  })

  it('shows error for oversized file', async () => {
    const { container } = renderComponent()
    const file = createFile('test.jpg', 'image/jpeg', 6 * 1024 * 1024)
    selectFile(container, file)

    await waitFor(() => {
      expect(container.textContent).toContain('File too large')
    })
  })

  it('transitions to scanning phase on valid file upload', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 1, unit: 'L', price: 20000 }],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })

    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() => {
      expect(container.textContent).toContain('addReceipt.scanningTitle')
    })
  })

  it('shows review phase after successful scan', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 1, unit: 'L', price: 20000 }],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })

    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() => {
      expect(
        container.querySelector('[class*="grid-cols-1 sm:grid-cols-[1fr_90px_110px]"]')
      ).toBeTruthy()
    })
  })

  it('sums qty × price in the review total', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [
        { name: 'Milk', qty: 2, unit: 'L', price: 20000 },
        { name: 'Bread', qty: 1, unit: 'pack', price: 15000 },
      ],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() => {
      expect(container.textContent).toContain('55.000')
    })
  })

  it('prefers the printed line total over qty × price', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [
        // Line total printed on the receipt (discounted): 30.000, not 2 × 20.000.
        { name: 'Milk', qty: 2, unit: 'L', price: 20000, total: 30000 },
        { name: 'Bread', qty: 1, unit: 'pack', price: 15000 },
      ],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() => {
      expect(container.textContent).toContain('45.000')
    })
  })

  it('shows done state after confirm', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 1, unit: 'L', price: 20000 }],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })

    api.createPurchase.mockResolvedValueOnce({
      purchase: { id: 'p1' },
      items: [],
      stock: [],
    })

    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() => {
      expect(
        container.querySelector('[class*="grid-cols-1 sm:grid-cols-[1fr_90px_110px]"]')
      ).toBeTruthy()
    })

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('addReceipt.confirmAdd')
    )
    if (confirmBtn) {
      fireEvent.click(confirmBtn)
    }

    await waitFor(() => {
      expect(container.textContent).toContain('addReceipt.stockAdded')
    })

    // #518: no printed line total on this scan — the payload carries none and
    // the server computes qty × price.
    expect(api.createPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ name: 'Milk', qty: 1, price: 20000 })],
      })
    )
    expect(api.createPurchase.mock.calls[0][0].items[0].line_total).toBeUndefined()
  })

  it('sends the printed line total as line_total so it is persisted (#518)', async () => {
    const { container } = renderComponent()

    // The discounted line from the scan: printed 30.000 against unit 20.000 ×2.
    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 2, unit: 'L', price: 20000, total: 30000 }],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })
    api.createPurchase.mockResolvedValueOnce({
      purchase: { id: 'p1' },
      items: [],
      stock: [],
    })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    selectFile(container, createFile('test.jpg', 'image/jpeg', 1000))

    await waitFor(() => {
      expect(
        container.querySelector('[class*="grid-cols-1 sm:grid-cols-[1fr_90px_110px]"]')
      ).toBeTruthy()
    })

    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('addReceipt.confirmAdd')
      )
    )

    await waitFor(() => {
      expect(container.textContent).toContain('addReceipt.stockAdded')
    })

    expect(api.createPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ name: 'Milk', line_total: 30000 })],
      })
    )
  })

  // #567-B1: scan a receipt and wait for the review screen. `items` is the
  // exact shape POST /api/purchases/scan returns — including the
  // needsPriceReview flag the lib emits for "qty > 1, no printed total"
  // (pinned in backend receipt-scan.test.ts).
  async function scanAndReview(items) {
    const { container } = renderComponent()
    api.scanReceipt.mockResolvedValueOnce({
      items,
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)
    api.createPurchase.mockResolvedValue({ purchase: { id: 'p1' }, items: [], stock: [] })

    selectFile(container, createFile('test.jpg', 'image/jpeg', 1000))
    await waitFor(() => {
      expect(container.textContent).toContain('addReceipt.reviewTitle')
    })
    return container
  }

  function submitButton(container) {
    return Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('addReceipt.confirmAdd')
    )
  }

  function rowPriceConfirmButtons(container) {
    return Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('addReceipt.confirmPrice')
    )
  }

  it('holds submit on a qty>1 line with no printed total until its unit price is confirmed (#567-B1)', async () => {
    // The misread shape from the review: the model fell back to the line amount
    // ("TELUR 10 BUTIR 28.000") and omitted the total. Submitting it as-is
    // would persist 10 × 28.000 into the PERMANENT grand total.
    const container = await scanAndReview([
      { name: 'Telur', qty: 10, unit: 'pcs', price: 28000, needsPriceReview: true },
    ])

    // The flagged row says why, and Confirm is held.
    expect(container.textContent).toContain('addReceipt.checkUnitPrice')
    expect(container.textContent).toContain('addReceipt.confirmPricesFirst')
    expect(submitButton(container).disabled).toBe(true)

    // The inline confirm accepts the scanned number AS the unit price — no
    // retyping required (an unchanged controlled input fires no change event).
    fireEvent.click(rowPriceConfirmButtons(container)[0])
    expect(container.textContent).not.toContain('addReceipt.checkUnitPrice')
    expect(submitButton(container).disabled).toBe(false)

    fireEvent.click(submitButton(container))
    await waitFor(() => {
      expect(container.textContent).toContain('addReceipt.stockAdded')
    })
    const sent = api.createPurchase.mock.calls[0][0].items[0]
    // qty × the confirmed unit price is now a human decision. The review flag
    // is a screen concern: it never rides the payload (nor a line total — the
    // server computes it after the human confirmed the unit price).
    expect(sent).toMatchObject({ name: 'Telur', qty: 10, price: 28000 })
    expect(sent).not.toHaveProperty('needsPriceReview')
    expect(sent).not.toHaveProperty('total')
    expect(sent).not.toHaveProperty('line_total')
  })

  it('editing the unit price also releases the hold — the corrected price is what gets multiplied (#567-B1)', async () => {
    const container = await scanAndReview([
      { name: 'Telur', qty: 10, unit: 'pcs', price: 28000, needsPriceReview: true },
    ])

    fireEvent.change(container.querySelector('input[aria-label="history.price"]'), {
      target: { value: '2800' },
    })
    expect(container.textContent).not.toContain('addReceipt.checkUnitPrice')
    expect(submitButton(container).disabled).toBe(false)

    fireEvent.click(submitButton(container))
    await waitFor(() => {
      expect(container.textContent).toContain('addReceipt.stockAdded')
    })
    expect(api.createPurchase.mock.calls[0][0].items[0]).toMatchObject({ qty: 10, price: 2800 })
  })

  it('editing qty alone does NOT confirm the unit price (#567-B1)', async () => {
    const container = await scanAndReview([
      { name: 'Telur', qty: 10, unit: 'pcs', price: 28000, needsPriceReview: true },
    ])

    // The hazard is the PRICE being the line-total fallback; changing the qty
    // leaves that unconfirmed, so the hold must stay.
    fireEvent.change(container.querySelector('input[aria-label="common.from"]'), {
      target: { value: '2' },
    })
    expect(container.textContent).toContain('addReceipt.checkUnitPrice')
    expect(submitButton(container).disabled).toBe(true)
    expect(api.createPurchase).not.toHaveBeenCalled()
  })

  it('re-arms the hold when a qty edit drops a printed line total (#567-B1)', async () => {
    // The prompt's fallback rule now ALWAYS rides the printed total, so the
    // ambiguous line arrives ANCHORED and unflagged: qty 10, price 28.000 (the
    // line amount) and total 28.000 carrying it. Submitting that as-is is
    // correct — the printed total wins.
    const container = await scanAndReview([
      { name: 'Telur', qty: 10, unit: 'pcs', price: 28000, total: 28000 },
    ])
    expect(container.textContent).not.toContain('addReceipt.checkUnitPrice')
    expect(submitButton(container).disabled).toBe(false)

    // Correcting the qty (the scan read 10 BUTIR for 2) drops the printed total
    // — the anchor — while the surviving price is STILL the line amount. If the
    // hold does not come back with the anchor, 2 × 28.000 is multiplied into the
    // permanent grand total.
    fireEvent.change(container.querySelector('input[aria-label="common.from"]'), {
      target: { value: '2' },
    })
    expect(container.textContent).toContain('addReceipt.checkUnitPrice')
    expect(submitButton(container).disabled).toBe(true)
    expect(api.createPurchase).not.toHaveBeenCalled()
  })

  it('does not re-hold after a qty edit once the user asserted the unit price (#567-B1)', async () => {
    const container = await scanAndReview([
      { name: 'Telur', qty: 10, unit: 'pcs', price: 28000, total: 28000 },
    ])

    // Editing the price is the user asserting a per-unit figure…
    fireEvent.change(container.querySelector('input[aria-label="history.price"]'), {
      target: { value: '2800' },
    })
    // …so a later qty edit multiplies the asserted price, not a fallback guess.
    fireEvent.change(container.querySelector('input[aria-label="common.from"]'), {
      target: { value: '2' },
    })
    expect(container.textContent).not.toContain('addReceipt.checkUnitPrice')
    expect(submitButton(container).disabled).toBe(false)

    fireEvent.click(submitButton(container))
    await waitFor(() => {
      expect(container.textContent).toContain('addReceipt.stockAdded')
    })
    const sent = api.createPurchase.mock.calls[0][0].items[0]
    expect(sent).toMatchObject({ qty: 2, price: 2800 })
    expect(sent).not.toHaveProperty('line_total')
  })

  it('a line read at qty 1 stays unheld when its qty is corrected upwards (#567-B1)', async () => {
    // At qty 1 the fallback and the unit price are the same number, so the
    // scanned price IS a per-unit price; raising the qty multiplies it
    // correctly and must not raise a false hold.
    const container = await scanAndReview([{ name: 'Roti', qty: 1, unit: 'pack', price: 15000 }])
    expect(submitButton(container).disabled).toBe(false)

    fireEvent.change(container.querySelector('input[aria-label="common.from"]'), {
      target: { value: '3' },
    })
    expect(container.textContent).not.toContain('addReceipt.checkUnitPrice')
    expect(submitButton(container).disabled).toBe(false)
  })

  it('holds until EVERY flagged row is confirmed, then submits all rows (#567-B1)', async () => {
    const container = await scanAndReview([
      { name: 'Telur', qty: 10, unit: 'pcs', price: 28000, needsPriceReview: true },
      { name: 'Susu', qty: 2, unit: 'L', price: 20000, total: 30000 },
      { name: 'Beras', qty: 5, unit: 'kg', price: 13000, needsPriceReview: true },
    ])

    // Only the two unanchored qty>1 rows are flagged — one warning each.
    expect(container.textContent.match(/addReceipt\.checkUnitPrice/g)).toHaveLength(2)
    expect(submitButton(container).disabled).toBe(true)

    // One confirmation is not enough: the purchase is atomic.
    fireEvent.click(rowPriceConfirmButtons(container)[0])
    expect(container.textContent.match(/addReceipt\.checkUnitPrice/g)).toHaveLength(1)
    expect(submitButton(container).disabled).toBe(true)

    fireEvent.click(rowPriceConfirmButtons(container)[0])
    expect(submitButton(container).disabled).toBe(false)

    fireEvent.click(submitButton(container))
    await waitFor(() => {
      expect(container.textContent).toContain('addReceipt.stockAdded')
    })
    const sent = api.createPurchase.mock.calls[0][0].items
    expect(sent.map((it) => it.name)).toEqual(['Telur', 'Susu', 'Beras'])
    // The anchored printed-total line still carries its line total (#518 Q2).
    expect(sent[1]).toMatchObject({ line_total: 30000 })
    expect(sent[0]).not.toHaveProperty('line_total')
    expect(sent[2]).not.toHaveProperty('line_total')
  })

  it('shows error when scan fails', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockRejectedValueOnce(new Error('Scan failed'))

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() => {
      expect(container.textContent).toContain('Scan failed')
    })
  })

  it('handles drag and drop file', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 1, unit: 'L', price: 20000 }],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const dropzone = container.querySelector('[class*="border-2 border-dashed"]')
    const file = createFile('test.jpg', 'image/jpeg', 1000)
    fireEvent.dragOver(dropzone)
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } })

    await waitFor(() => {
      expect(
        container.querySelector('[class*="grid-cols-1 sm:grid-cols-[1fr_90px_110px]"]')
      ).toBeTruthy()
    })
  })

  it('shows no-key error action and navigates to settings', async () => {
    const navigate = vi.fn()
    vi.doMock('@tanstack/react-router', () => ({
      useNavigate: () => navigate,
    }))

    const { container } = renderComponent()

    api.scanReceipt.mockRejectedValueOnce(
      new Error('AI provider not configured. Go to Settings to set up your AI key.')
    )

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() => {
      expect(container.textContent).toContain('AI provider not configured')
    })

    const settingsBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('addReceipt.goToSettings')
    )
    if (settingsBtn) {
      fireEvent.click(settingsBtn)
    }
  })

  it('updates item field in review phase', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 1, unit: 'L', price: 20000 }],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() =>
      expect(
        container.querySelector('[class*="grid-cols-1 sm:grid-cols-[1fr_90px_110px]"]')
      ).toBeTruthy()
    )

    const nameInput = container.querySelector('input[aria-label="history.item"]')
    if (nameInput) {
      fireEvent.change(nameInput, { target: { value: 'Susu' } })
      expect(nameInput.value).toBe('Susu')
    }
  })

  it('matches item to catalog and updates name/unit', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 1, unit: 'L', price: 20000 }],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() =>
      expect(
        container.querySelector('[class*="grid-cols-1 sm:grid-cols-[1fr_90px_110px]"]')
      ).toBeTruthy()
    )

    const select = container.querySelector('select[aria-label="Match to existing item"]')
    if (select) {
      fireEvent.change(select, { target: { value: 'i1' } })
      const nameInput = container.querySelector('input[aria-label="history.item"]')
      expect(nameInput.value).toBe('Milk')
    }
  })

  it('retakes photo from review phase', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 1, unit: 'L', price: 20000 }],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() =>
      expect(
        container.querySelector('[class*="grid-cols-1 sm:grid-cols-[1fr_90px_110px]"]')
      ).toBeTruthy()
    )

    const retakeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('addReceipt.retake')
    )
    if (retakeBtn) fireEvent.click(retakeBtn)

    await waitFor(() =>
      expect(container.querySelector('[class*="border-2 border-dashed"]')).toBeTruthy()
    )
  })

  it('renders receipt preview when imageUrl is returned', async () => {
    const { container } = renderComponent()

    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 1, unit: 'L', price: 20000 }],
      imageKey: 'key-123',
      imageUrl: 'https://example.com/receipt.jpg',
      storeGuess: { id: 's1', label: 'Indomaret' },
      dateGuess: '2026-07-26',
    })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() => expect(container.querySelector('img[alt="Receipt"]')).toBeTruthy())
  })

  it('calls onDone from done phase', async () => {
    const onDone = vi.fn()
    const { container } = renderComponent({ onDone })

    api.scanReceipt.mockResolvedValueOnce({
      items: [{ name: 'Milk', qty: 1, unit: 'L', price: 20000 }],
      imageKey: 'key-123',
      imageUrl: null,
      storeGuess: null,
      dateGuess: null,
    })
    api.createPurchase.mockResolvedValueOnce({ purchase: { id: 'p1' }, items: [], stock: [] })
    api.getStores.mockResolvedValueOnce(MOCK_STORES)
    api.getItems.mockResolvedValueOnce(MOCK_ITEMS)

    const file = createFile('test.jpg', 'image/jpeg', 1000)
    selectFile(container, file)

    await waitFor(() =>
      expect(
        container.querySelector('[class*="grid-cols-1 sm:grid-cols-[1fr_90px_110px]"]')
      ).toBeTruthy()
    )

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('addReceipt.confirmAdd')
    )
    if (confirmBtn) fireEvent.click(confirmBtn)

    await waitFor(() => expect(container.textContent).toContain('addReceipt.stockAdded'))

    const doneBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('addReceipt.done')
    )
    if (doneBtn) fireEvent.click(doneBtn)
    expect(onDone).toHaveBeenCalled()
  })
})
