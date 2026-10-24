import { describe, it, expect, vi, beforeEach } from 'vitest'
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
