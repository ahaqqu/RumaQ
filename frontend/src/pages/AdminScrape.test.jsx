import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { ApiError } from '../lib/api'
import { AdminScrape } from './AdminScrape.jsx'

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  ACTIVE_STATUSES: new Set(['pending', 'running']),
  useScrapeStores: vi.fn(),
  useScrapeCommands: vi.fn(),
  useScrapeEvents: vi.fn(),
  useTriggerScrape: vi.fn(),
}))

import { useMe } from '../lib/queries/me.js'
import {
  useScrapeStores,
  useScrapeCommands,
  useScrapeEvents,
  useTriggerScrape,
} from '../lib/queries/index.js'

const emptyEvents = { events: [], truncated: false }

function mockCommand(overrides = {}) {
  return {
    id: 'cmd-1',
    stores: ['superindo'],
    status: 'success',
    createdBy: 'op@rumaq.dev',
    createdAt: '2026-10-29T01:00:00.000Z',
    pickedUpAt: '2026-10-29T01:00:05.000Z',
    finishedAt: '2026-10-29T01:02:00.000Z',
    exitCode: 0,
    error: null,
    logTruncated: false,
    ...overrides,
  }
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

function renderAdmin() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(AdminScrape, null)
    )
  )
}

function findButton(container, label) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes(label)
  )
}

// The suite's i18n mock returns raw keys, so assertions match keys and
// un-translated data (store slugs, error strings, log lines).
describe('AdminScrape', () => {
  let mutate

  beforeEach(() => {
    mutate = vi.fn()
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: true } } })
    vi.mocked(useScrapeStores).mockReturnValue({
      data: { stores: ['superindo', 'lotte-mart', 'astro', 'hypermart', 'indomaret', 'alfamart'] },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useScrapeCommands).mockReturnValue({
      data: { commands: [] },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useScrapeEvents).mockReturnValue({ data: emptyEvents, isLoading: false })
    vi.mocked(useTriggerScrape).mockReturnValue({ mutate, isPending: false, error: null })
  })

  it('shows the forbidden state for non-admins', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { isAdmin: false } } })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('scrape.forbidden')
    expect(container.textContent).not.toContain('scrape.history')
  })

  it('renders the store checkboxes, trigger, and history shell', () => {
    const { container } = renderAdmin()
    expect(container.textContent).toContain('scrape.triggerTitle')
    expect(container.textContent).toContain('superindo')
    expect(container.textContent).toContain('lotte-mart')
    expect(container.textContent).toContain('astro')
    expect(container.textContent).toContain('scrape.scrapeNow')
    expect(container.textContent).toContain('scrape.history')
  })

  it('disables Scrape Now until a store is selected, then queues the selection', () => {
    const { container } = renderAdmin()
    const button = findButton(container, 'scrape.scrapeNow')
    expect(button.disabled).toBe(true)

    const checkbox = container.querySelector('input[type="checkbox"]')
    fireEvent.click(checkbox)
    expect(button.disabled).toBe(false)

    fireEvent.click(button)
    // The payload is the whole create body — a plain scrape carries both flags
    // false and the wire payload omits them (undefined), byte-identical.
    expect(mutate).toHaveBeenCalledWith(
      { stores: ['superindo'], resetNovelty: false, wipeIngest: false },
      expect.anything()
    )
  })

  it('renders the #753 re-ingest flag checkboxes', () => {
    const { container } = renderAdmin()
    expect(container.querySelector('[data-testid="scrape-reset-novelty"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="scrape-wipe-ingest"]')).toBeTruthy()
    expect(container.textContent).toContain('scrape.resetNovelty')
    expect(container.textContent).toContain('scrape.wipeIngest')
    // The wipe hint names the single-store rule while the selection is empty.
    expect(container.textContent).toContain('scrape.wipeSingleStore')
  })

  it('queues a plain create without flags riding the payload as false', () => {
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('input[type="checkbox"]'))
    fireEvent.click(findButton(container, 'scrape.scrapeNow'))
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ resetNovelty: false, wipeIngest: false }),
      expect.anything()
    )
  })

  it('carries resetNovelty into the payload when the checkbox is armed', () => {
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('input[type="checkbox"]'))
    fireEvent.click(container.querySelector('[data-testid="scrape-reset-novelty"]'))
    fireEvent.click(findButton(container, 'scrape.scrapeNow'))
    expect(mutate).toHaveBeenCalledWith(
      { stores: ['superindo'], resetNovelty: true, wipeIngest: false },
      expect.anything()
    )
  })

  it('wipe requires a typed-slug confirm and blocks the queue until it matches', () => {
    const { container } = renderAdmin()
    fireEvent.click(container.querySelector('input[type="checkbox"]'))
    fireEvent.click(container.querySelector('[data-testid="scrape-wipe-ingest"]'))
    // The confirm gate appears and names the store to type.
    expect(container.textContent).toContain('scrape.wipeConfirmLabel')
    const confirm = container.querySelector('[data-testid="scrape-wipe-confirm"]')
    expect(confirm).toBeTruthy()

    const button = findButton(container, 'scrape.scrapeNow')
    // Wipe armed but not confirmed: the queue stays locked.
    expect(button.disabled).toBe(true)

    fireEvent.change(confirm, { target: { value: 'wrong-slug' } })
    expect(button.disabled).toBe(true)

    fireEvent.change(confirm, { target: { value: 'superindo' } })
    expect(button.disabled).toBe(false)

    fireEvent.click(button)
    expect(mutate).toHaveBeenCalledWith(
      { stores: ['superindo'], resetNovelty: false, wipeIngest: true },
      expect.anything()
    )
  })

  it('disarms the wipe when the selection stops being a single store', () => {
    const { container } = renderAdmin()
    const [superindo, lotte] = container.querySelectorAll('input[type="checkbox"]')
    fireEvent.click(superindo)
    fireEvent.click(container.querySelector('[data-testid="scrape-wipe-ingest"]'))
    expect(container.querySelector('[data-testid="scrape-wipe-confirm"]')).toBeTruthy()

    // A second store joins: single-store rule kicks in — the wipe disarms and
    // the confirm input disappears even if its text was already correct.
    fireEvent.click(lotte)
    expect(container.querySelector('[data-testid="scrape-wipe-confirm"]')).toBeNull()
    expect(findButton(container, 'scrape.scrapeNow').disabled).toBe(false)
    fireEvent.click(findButton(container, 'scrape.scrapeNow'))
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ wipeIngest: false }),
      expect.anything()
    )
  })

  it('shows the created command id and the wipe counts after a successful queue', () => {
    const { container } = renderAdmin()
    mutate.mockImplementation((_payload, opts) => {
      opts?.onSuccess?.({
        id: 'cmd-created-9',
        wipe: {
          receiptId: 'r1',
          storeSlug: 'superindo',
          observationsDeleted: 12,
          productsDeleted: 3,
        },
      })
    })
    fireEvent.click(container.querySelector('input[type="checkbox"]'))
    fireEvent.click(findButton(container, 'scrape.scrapeNow'))
    const queued = container.querySelector('[data-testid="scrape-queued-command"]')
    expect(queued).toBeTruthy()
    // The suite's i18n mock returns raw keys (no interpolation), so the echo
    // is pinned by its keys: the created-command line and the wipe counts.
    expect(queued.textContent).toContain('scrape.queuedCommand')
    expect(queued.textContent).toContain('scrape.queuedWipe')
  })

  it('blocks the trigger and shows the active-run card while a command runs', () => {
    vi.mocked(useScrapeCommands).mockReturnValue({
      data: { commands: [mockCommand({ status: 'running', stores: ['astro'] })] },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('scrape.activeRun')
    expect(container.textContent).toContain('scrape.statusRunning')
    expect(container.textContent).toContain('astro')
    // The active command lives in its card, not duplicated in history.
    expect(container.textContent).not.toContain('scrape.noCommands')
    const button = findButton(container, 'scrape.scrapeNow')
    expect(button.disabled).toBe(true)
    // The live log hook is fed the running command.
    expect(useScrapeEvents).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cmd-1', status: 'running' })
    )
  })

  it('shows the live log lines with the error line, and the truncation notice', () => {
    vi.mocked(useScrapeCommands).mockReturnValue({
      data: { commands: [mockCommand({ status: 'running', logTruncated: true })] },
      isLoading: false,
      isError: false,
    })
    vi.mocked(useScrapeEvents).mockReturnValue({
      data: {
        truncated: true,
        events: [
          { seq: 0, ts: '2026-10-29T01:00:06.000Z', level: 'info', message: 'starting run' },
          { seq: 1, ts: '2026-10-29T01:01:00.000Z', level: 'error', message: 'store exploded' },
        ],
      },
      isLoading: false,
    })
    const { container } = renderAdmin()
    expect(container.querySelector('[data-testid="scrape-log"]')).toBeTruthy()
    expect(container.textContent).toContain('starting run')
    expect(container.textContent).toContain('store exploded')
    expect(container.textContent).toContain('scrape.logTruncated')
  })

  it('shows the waiting note while a command is pending', () => {
    vi.mocked(useScrapeCommands).mockReturnValue({
      data: { commands: [mockCommand({ status: 'pending' })] },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('scrape.statusPending')
    expect(container.textContent).toContain('scrape.waitingForAgent')
  })

  it('surfaces the 409 conflict as an inline already-running message', () => {
    vi.mocked(useTriggerScrape).mockReturnValue({
      mutate,
      isPending: false,
      error: { status: 409 },
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('scrape.alreadyRunning')
    expect(container.textContent).not.toContain('scrape.queueError')
  })

  it('surfaces other trigger failures as a queue error', () => {
    vi.mocked(useTriggerScrape).mockReturnValue({
      mutate,
      isPending: false,
      error: { status: 500 },
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('scrape.queueError')
    expect(container.textContent).not.toContain('scrape.alreadyRunning')
  })

  it('shows the queueing label while the mutation is in flight', () => {
    vi.mocked(useTriggerScrape).mockReturnValue({ mutate, isPending: true, error: null })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('scrape.queueing')
    expect(findButton(container, 'scrape.queueing').disabled).toBe(true)
  })

  it('renders recent commands with status dots and expands to the full event log', () => {
    vi.mocked(useScrapeCommands).mockReturnValue({
      data: {
        commands: [
          mockCommand({
            status: 'failed',
            exitCode: 1,
            error: 'PipelineFailure: no stores matched',
          }),
        ],
      },
      isLoading: false,
      isError: false,
    })
    // The full log the expansion loads (the failure-log view).
    vi.mocked(useScrapeEvents).mockReturnValue({
      data: {
        events: [
          { seq: 0, ts: '2026-10-29T01:00:06.000Z', level: 'info', message: 'starting run' },
          { seq: 1, ts: '2026-10-29T01:01:59.000Z', level: 'error', message: 'store exploded' },
        ],
        truncated: false,
      },
      isLoading: false,
    })
    const { container } = renderAdmin()
    expect(container.textContent).toContain('scrape.statusFailed')
    expect(container.textContent).toContain('PipelineFailure: no stores matched')
    // Collapsed: the event log hook is not yet mounted for the row.
    expect(container.querySelector('[data-testid="scrape-log"]')).toBeNull()
    expect(container.textContent).not.toContain('store exploded')

    fireEvent.click(container.querySelector('button[aria-expanded]'))
    expect(container.querySelector('[data-testid="scrape-log"]')).toBeTruthy()
    expect(container.textContent).toContain('store exploded')
    expect(container.textContent).toContain('scrape.createdBy')
    expect(container.textContent).toContain('scrape.exitCode')
    expect(useScrapeEvents).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cmd-1', status: 'failed' })
    )
  })

  it('renders the empty state when no commands exist', () => {
    const { container } = renderAdmin()
    expect(container.textContent).toContain('scrape.noCommands')
    expect(container.textContent).toContain('scrape.noCommandsDesc')
  })

  it('shows the command id and the #753 flags in the expanded detail', () => {
    vi.mocked(useScrapeCommands).mockReturnValue({
      data: { commands: [mockCommand({ resetNovelty: true, wipeIngest: true })] },
      isLoading: false,
      isError: false,
    })
    const { container } = renderAdmin()
    // Collapsed: the flags are not rendered.
    expect(container.textContent).not.toContain('scrape.flagWipeIngest')
    fireEvent.click(container.querySelector('button[aria-expanded]'))
    expect(container.textContent).toContain('scrape.commandId')
    expect(container.textContent).toContain('cmd-1')
    expect(container.textContent).toContain('scrape.flagResetNovelty')
    expect(container.textContent).toContain('scrape.flagWipeIngest')
  })

  it('renders a dedicated error state when the command history fails to load', () => {
    vi.mocked(useScrapeCommands).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      // L5 (audit): a 500 must not read as "offline" — the description is the
      // M1-kind copy (error.http), never the offline banner.
      error: new ApiError('Request failed: 500', 500),
    })
    const { container } = renderAdmin()
    // A 5xx must not read as "no data" — its own title, not scrape.noCommands.
    expect(container.textContent).toContain('scrape.loadError')
    expect(container.textContent).toContain('error.http')
    expect(container.textContent).not.toContain('offline.banner')
    expect(container.textContent).not.toContain('scrape.noCommands')
  })
})
