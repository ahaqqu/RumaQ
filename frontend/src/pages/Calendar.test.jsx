import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Calendar } from './Calendar.jsx'
import { nextBirthday } from '../lib/household-date.js'

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  useHouseholds: vi.fn(),
  useHouseholdMembers: vi.fn(),
  useCalendar: vi.fn(),
  useCreateCalendarEvent: vi.fn(),
  useUpdateCalendarEvent: vi.fn(),
  useDeleteCalendarEvent: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(message, status) {
      super(message)
      this.status = status
    }
  },
}))

import { useMe } from '../lib/queries/me.js'
import {
  useHouseholds,
  useHouseholdMembers,
  useCalendar,
  useCreateCalendarEvent,
  useUpdateCalendarEvent,
  useDeleteCalendarEvent,
} from '../lib/queries/index.js'

// The test-setup i18n mock renders keys verbatim, so assertions run on raw
// keys (the Tasks/Documents page-test convention); entry titles and member
// names are real data, not translations.

function mutation(overrides = {}) {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, ...overrides }
}

const HOUSEHOLDS_OWNER = {
  households: [
    { id: 'h1', name: 'Keluarga Putri', role: 'owner', member_count: 3, is_active: true },
  ],
}

const HOUSEHOLDS_MEMBER = {
  households: [
    { id: 'h1', name: 'Keluarga Putri', role: 'member', member_count: 3, is_active: true },
  ],
}

const MEMBERS = {
  members: [
    {
      id: 'm-ibu',
      user_id: 'u1',
      has_account: true,
      role: 'owner',
      display_name: null,
      name: 'Ibu',
      email: 'ibu@example.com',
      picture: null,
      joined_at: '2026-11-01 00:00:00',
      birth_date: null,
    },
    {
      id: 'm-ayah',
      user_id: 'u2',
      has_account: true,
      role: 'member',
      display_name: null,
      name: 'Ayah',
      email: 'ayah@example.com',
      picture: null,
      joined_at: '2026-11-01 00:00:00',
      birth_date: null,
    },
    {
      id: 'm-anak',
      user_id: null,
      has_account: false,
      role: 'member',
      display_name: 'Adik',
      name: null,
      email: null,
      picture: null,
      joined_at: '2026-11-02 00:00:00',
      birth_date: '2022-06-15',
    },
  ],
}

// The page views the CURRENT month (the household's WIB day) — fixtures and
// assertions derive their dates from the same formula so the tests never
// depend on the wall clock.
function currentMonth() {
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7)) - 1
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const pad = (n) => String(n).padStart(2, '0')
  return {
    today,
    year,
    month,
    iso: (day) => `${year}-${pad(month + 1)}-${pad(day)}`,
    from: `${year}-${pad(month + 1)}-01`,
    to: `${year}-${pad(month + 1)}-${pad(last)}`,
  }
}

const EVENT = {
  kind: 'event',
  id: 'e1',
  household_id: 'h1',
  title: 'Kontrol dokter',
  date: null, // set per test from the current month
  time: '09:30',
  visibility: 'all',
  member_ids: null,
  created_by_member_id: 'm-ibu',
  created_at: '2026-11-05 00:00:00',
  updated_at: '2026-11-05 00:00:00',
}

const MEMBERS_EVENT = {
  ...EVENT,
  id: 'e2',
  title: 'Surprise untuk ayah',
  time: null,
  visibility: 'members',
  member_ids: ['m-anak'],
  created_by_member_id: 'm-ayah',
}

const DEADLINE = {
  kind: 'deadline',
  id: 'doc:d1',
  document_id: 'd1',
  title: 'STNK Bapak',
  date: null, // set per test
  member_id: 'm-ibu',
  days_until_expiry: 12,
  due_soon: true,
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

function renderCalendar() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(Calendar, null)
    )
  )
}

function findButton(container, label) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes(label)
  )
}

function findChip(container, label) {
  return [...container.querySelectorAll('button[aria-pressed]')].find((chip) =>
    chip.textContent.includes(label)
  )
}

describe('Calendar page', () => {
  const month = currentMonth()

  beforeEach(() => {
    vi.clearAllMocks()
    window.confirm = vi.fn(() => true)
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_OWNER, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useCreateCalendarEvent).mockReturnValue(mutation())
    vi.mocked(useUpdateCalendarEvent).mockReturnValue(mutation())
    vi.mocked(useDeleteCalendarEvent).mockReturnValue(mutation())
    useCalendar.mockImplementation((_win) => ({ data: { entries: [] }, isLoading: false }))
  })

  it('renders the month grid and requests the month window', () => {
    const { container } = renderCalendar()
    expect(container.querySelector(`[data-testid="day-${month.iso(10)}"]`)).toBeTruthy()
    // The month window rides the query key: [first, last] of the visible month.
    expect(vi.mocked(useCalendar)).toHaveBeenCalledWith({ from: month.from, to: month.to })
    // The quick-add presets are first-class (visible buttons, not hidden rows).
    expect(findButton(container, 'calendar.preset.school')).toBeTruthy()
    expect(findButton(container, 'calendar.preset.mudik')).toBeTruthy()
    expect(findButton(container, 'calendar.preset.tax')).toBeTruthy()
    expect(findButton(container, 'calendar.preset.birthday')).toBeTruthy()
  })

  it('selects a day and lists its entries: events with manage affordances, deadlines read-only', () => {
    useCalendar.mockImplementation(() => ({
      data: {
        entries: [
          { ...EVENT, date: month.iso(10) },
          { ...DEADLINE, date: month.iso(10) },
        ],
      },
      isLoading: false,
    }))
    const { container } = renderCalendar()
    fireEvent.click(container.querySelector(`[data-testid="day-${month.iso(10)}"]`))

    const dayList = container.querySelector('[data-testid="day-list"]')
    expect(dayList.textContent).toContain('Kontrol dokter')
    expect(dayList.textContent).toContain('STNK Bapak')
    // The deadline chip marks the derived row — it carries no manage buttons.
    expect(dayList.textContent).toContain('calendar.deadlineChip')
    expect(dayList.textContent).toContain('calendar.expiresIn')
    expect(dayList.textContent).toContain('calendar.dueSoon')
    expect(dayList.querySelectorAll('[data-testid="deadline-row"]')).toHaveLength(1)
    expect(dayList.querySelectorAll('[data-testid="event-row"]')).toHaveLength(1)
    // The owner manages every event; the deadline row never gets one.
    expect(dayList.querySelectorAll('button[aria-label="calendar.delete"]')).toHaveLength(1)
  })

  it('shows the audience of a members-event resolved through the roster', () => {
    useCalendar.mockImplementation(() => ({
      data: { entries: [{ ...MEMBERS_EVENT, date: month.iso(12) }] },
      isLoading: false,
    }))
    const { container } = renderCalendar()
    fireEvent.click(container.querySelector(`[data-testid="day-${month.iso(12)}"]`))
    const dayList = container.querySelector('[data-testid="day-list"]')
    expect(dayList.textContent).toContain('calendar.visibleTo')
    // The mock renders the template KEY verbatim, so the resolved names ride
    // the title attribute — real data, not translations.
    expect(dayList.querySelector('[title="Adik"]')).toBeTruthy()
    // Ayah (linked member, not owner) created it — ibu the owner can manage.
    expect(dayList.querySelector('button[aria-label="calendar.delete"]')).toBeTruthy()
  })

  it('hides manage affordances from a non-manager member', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u2' } } }) // ayah
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_MEMBER, isLoading: false })
    useCalendar.mockImplementation(() => ({
      data: { entries: [{ ...EVENT, date: month.iso(10) }] }, // created by ibu
      isLoading: false,
    }))
    const { container } = renderCalendar()
    fireEvent.click(container.querySelector(`[data-testid="day-${month.iso(10)}"]`))
    expect(
      container
        .querySelector('[data-testid="day-list"]')
        .querySelectorAll('button[aria-label="calendar.delete"]')
    ).toHaveLength(0)
    expect(container.textContent).not.toContain('calendar.edit')
  })

  it('creates an event with the picked visibility and audience', () => {
    const create = mutation()
    vi.mocked(useCreateCalendarEvent).mockReturnValue(create)
    const { container } = renderCalendar()

    const titleInput = [...container.querySelectorAll('input')].find(
      (input) => input.getAttribute('aria-label') === 'calendar.titleLabel'
    )
    fireEvent.change(titleInput, { target: { value: 'Mudik checklist' } })
    fireEvent.click(findChip(container, 'calendar.visibilityMembers'))
    fireEvent.click(findChip(container, 'Adik'))

    fireEvent.click(findButton(container, 'calendar.create'))
    expect(create.mutate).toHaveBeenCalledWith(
      {
        title: 'Mudik checklist',
        date: month.today, // the selected day defaults to today
        time: null,
        visibility: 'members',
        member_ids: ['m-anak'],
      },
      expect.anything()
    )
  })

  it('prefills the create form from a quick-add preset', () => {
    const { container } = renderCalendar()
    fireEvent.click(findButton(container, 'calendar.preset.mudik'))
    const titleInput = [...container.querySelectorAll('input')].find(
      (input) => input.getAttribute('aria-label') === 'calendar.titleLabel'
    )
    expect(titleInput.value).toBe('calendar.presetContent.mudik.title')
    expect(container.textContent).toContain('calendar.presetContent.mudik.hint')
  })

  it('the birthday preset opens the member picker and prefills title + next-occurrence date', () => {
    const { container } = renderCalendar()
    fireEvent.click(findButton(container, 'calendar.preset.birthday'))
    const select = container.querySelector('[data-testid="birthday-member-select"]')
    expect(select).toBeTruthy()
    fireEvent.change(select, { target: { value: 'm-anak' } })
    const titleInput = [...container.querySelectorAll('input')].find(
      (input) => input.getAttribute('aria-label') === 'calendar.titleLabel'
    )
    expect(titleInput.value).toBe('calendar.birthdayTitle')
    // Adik's stored birth_date (2022-06-15) prefills the NEXT occurrence on
    // or after today — in every month, not just June. The expected value
    // comes from the same lib math the component calls (the clamp/rollover
    // cases are pinned with fixed inputs in household-date.test.js), so this
    // assertion never needs a month-conditional skip.
    const dateInput = container.querySelector('input[type="date"]')
    expect(dateInput.value).toBe(nextBirthday(MEMBERS.members[2].birth_date, month.today))
  })

  it('edits an event through the inline form', async () => {
    const update = mutation()
    vi.mocked(useUpdateCalendarEvent).mockReturnValue(update)
    useCalendar.mockImplementation(() => ({
      data: { entries: [{ ...EVENT, date: month.iso(10) }] },
      isLoading: false,
    }))
    const { container } = renderCalendar()
    fireEvent.click(container.querySelector(`[data-testid="day-${month.iso(10)}"]`))
    fireEvent.click(findButton(container, 'calendar.edit'))
    const editFields = container.querySelector('[data-testid="event-edit-fields"]')
    expect(editFields).toBeTruthy()
    const editTitle = editFields.querySelector('input')
    fireEvent.change(editTitle, { target: { value: 'Kontrol dokter — lab' } })
    fireEvent.click(
      [...editFields.querySelectorAll('button')].find((b) =>
        b.textContent.includes('calendar.saveEdit')
      )
    )
    await waitFor(() => expect(update.mutate).toHaveBeenCalled())
    const [{ id, payload }] = update.mutate.mock.calls[0]
    expect(id).toBe('e1')
    expect(payload.title).toBe('Kontrol dokter — lab')
    // Untouched fields ride as ABSENT — the backend reads that as "leave as
    // stored" (the lib's re-affirmation branch), which is what lets a
    // depleted members event take a title-only edit.
    expect(payload.visibility).toBeUndefined()
  })

  it('sends member_ids only when the audience changed', async () => {
    const update = mutation()
    vi.mocked(useUpdateCalendarEvent).mockReturnValue(update)
    useCalendar.mockImplementation(() => ({
      data: { entries: [{ ...MEMBERS_EVENT, date: month.iso(12) }] },
      isLoading: false,
    }))
    const { container } = renderCalendar()
    fireEvent.click(container.querySelector(`[data-testid="day-${month.iso(12)}"]`))
    fireEvent.click(findButton(container, 'calendar.edit'))
    const editFields = container.querySelector('[data-testid="event-edit-fields"]')
    const editTitle = editFields.querySelector('input')
    fireEvent.change(editTitle, { target: { value: 'Surprise untuk ayah — pindah hari' } })
    fireEvent.click(
      [...editFields.querySelectorAll('button')].find((b) =>
        b.textContent.includes('calendar.saveEdit')
      )
    )
    await waitFor(() => expect(update.mutate).toHaveBeenCalled())
    const [{ payload }] = update.mutate.mock.calls[0]
    expect(payload.title).toBe('Surprise untuk ayah — pindah hari')
    expect(payload.member_ids).toBeUndefined()
    expect(payload.visibility).toBeUndefined()
  })

  it('a depleted members event takes a title-only edit without re-affirming the empty audience', async () => {
    const update = mutation()
    vi.mocked(useUpdateCalendarEvent).mockReturnValue(update)
    useCalendar.mockImplementation(() => ({
      data: { entries: [{ ...MEMBERS_EVENT, member_ids: [], date: month.iso(12) }] },
      isLoading: false,
    }))
    const { container } = renderCalendar()
    fireEvent.click(container.querySelector(`[data-testid="day-${month.iso(12)}"]`))
    fireEvent.click(findButton(container, 'calendar.edit'))
    const editFields = container.querySelector('[data-testid="event-edit-fields"]')
    const editTitle = editFields.querySelector('input')
    fireEvent.change(editTitle, { target: { value: 'Surprise — catatan saja' } })
    fireEvent.click(
      [...editFields.querySelectorAll('button')].find((b) =>
        b.textContent.includes('calendar.saveEdit')
      )
    )
    await waitFor(() => expect(update.mutate).toHaveBeenCalled())
    const [{ payload }] = update.mutate.mock.calls[0]
    // member_ids: [] or an explicit visibility 'members' is exactly the
    // depleted re-affirmation the backend answers with a 400 — neither rides.
    expect(payload).not.toHaveProperty('member_ids')
    expect(payload).not.toHaveProperty('visibility')
  })

  it('rides the replacement audience through the PATCH when the chips move', async () => {
    const update = mutation()
    vi.mocked(useUpdateCalendarEvent).mockReturnValue(update)
    useCalendar.mockImplementation(() => ({
      data: { entries: [{ ...MEMBERS_EVENT, date: month.iso(12) }] },
      isLoading: false,
    }))
    const { container } = renderCalendar()
    fireEvent.click(container.querySelector(`[data-testid="day-${month.iso(12)}"]`))
    fireEvent.click(findButton(container, 'calendar.edit'))
    const editFields = container.querySelector('[data-testid="event-edit-fields"]')
    fireEvent.click(findChip(editFields, 'Ayah'))
    fireEvent.click(
      [...editFields.querySelectorAll('button')].find((b) =>
        b.textContent.includes('calendar.saveEdit')
      )
    )
    await waitFor(() => expect(update.mutate).toHaveBeenCalled())
    const [{ payload }] = update.mutate.mock.calls[0]
    expect(payload.member_ids).toEqual(['m-anak', 'm-ayah'])
    // Visibility was not touched, so it stays absent.
    expect(payload.visibility).toBeUndefined()
  })

  it('an untouched save after a mid-edit refetch swap leaves a concurrent audience grant stored', async () => {
    const update = mutation()
    vi.mocked(useUpdateCalendarEvent).mockReturnValue(update)
    // The refetch simulation: the mock reads this mutable binding, so flipping
    // it and rerendering stands in for the query data swapping under the open
    // form (refetchOnWindowFocus, the settle invalidations).
    let entries = [{ ...MEMBERS_EVENT, date: month.iso(12) }]
    useCalendar.mockImplementation(() => ({ data: { entries }, isLoading: false }))
    const client = createQueryClient()
    const ui = () =>
      React.createElement(QueryClientProvider, { client }, React.createElement(Calendar, null))
    const { container, rerender } = render(ui())
    fireEvent.click(container.querySelector(`[data-testid="day-${month.iso(12)}"]`))
    fireEvent.click(findButton(container, 'calendar.edit'))

    // Concurrent grant mid-edit: another member added ayah while the form sat
    // open, and the refetch delivered the fresh row. The open draft still
    // carries the seed audience (m-anak only).
    entries = [{ ...MEMBERS_EVENT, member_ids: ['m-anak', 'm-ayah'], date: month.iso(12) }]
    rerender(ui())
    // The swap landed — the row now renders the widened audience.
    expect(container.querySelector('[title="Adik, Ayah"]')).toBeTruthy()

    // Untouched save: nothing was edited. The stale seed list must NOT ride —
    // absent member_ids/visibility means "leave as stored", so the backend
    // keeps ['m-anak', 'm-ayah'] and the concurrent grant survives (C1R2-1).
    const editFields = container.querySelector('[data-testid="event-edit-fields"]')
    fireEvent.click(
      [...editFields.querySelectorAll('button')].find((b) =>
        b.textContent.includes('calendar.saveEdit')
      )
    )
    await waitFor(() => expect(update.mutate).toHaveBeenCalled())
    const [{ payload }] = update.mutate.mock.calls[0]
    expect(payload).not.toHaveProperty('member_ids')
    expect(payload).not.toHaveProperty('visibility')
  })

  it('deletes an event after confirmation', () => {
    const del = mutation()
    vi.mocked(useDeleteCalendarEvent).mockReturnValue(del)
    useCalendar.mockImplementation(() => ({
      data: { entries: [{ ...EVENT, date: month.iso(10) }] },
      isLoading: false,
    }))
    const { container } = renderCalendar()
    fireEvent.click(container.querySelector(`[data-testid="day-${month.iso(10)}"]`))
    fireEvent.click(container.querySelector('button[aria-label="calendar.delete"]'))
    expect(window.confirm).toHaveBeenCalled()
    expect(del.mutate).toHaveBeenCalledWith({ id: 'e1' }, expect.anything())
  })

  it('navigates months and moves the selection with the view', () => {
    const { container } = renderCalendar()
    const before = vi.mocked(useCalendar).mock.calls.at(-1)[0]
    fireEvent.click(container.querySelector('button[aria-label="calendar.nextMonth"]'))
    const after = vi.mocked(useCalendar).mock.calls.at(-1)[0]
    // The window slides one month forward on the same day numbers' boundaries.
    expect(after.from).not.toBe(before.from)
    const nextMonth = new Date(Date.UTC(month.year, month.month + 1, 1))
    const pad = (n) => String(n).padStart(2, '0')
    expect(after.from).toBe(`${nextMonth.getUTCFullYear()}-${pad(nextMonth.getUTCMonth() + 1)}-01`)
    // The grid re-renders with the new month's cells (the 1st is always
    // in-month).
    const nextIso = `${nextMonth.getUTCFullYear()}-${pad(nextMonth.getUTCMonth() + 1)}-01`
    expect(container.querySelector(`[data-testid="day-${nextIso}"]`)).toBeTruthy()
  })

  it('surfaces action errors through the copy keys', async () => {
    const failing = mutation({ mutate: vi.fn((_p, opts) => opts.onError(new Error('boom'))) })
    vi.mocked(useCreateCalendarEvent).mockReturnValue(failing)
    const { container } = renderCalendar()
    const titleInput = [...container.querySelectorAll('input')].find(
      (input) => input.getAttribute('aria-label') === 'calendar.titleLabel'
    )
    fireEvent.change(titleInput, { target: { value: 'X' } })
    fireEvent.click(findButton(container, 'calendar.create'))
    await waitFor(() => expect(container.textContent).toContain('calendar.errorGeneric'))
  })
})
