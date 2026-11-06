import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Tasks } from './Tasks.jsx'

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  useHouseholds: vi.fn(),
  useHouseholdMembers: vi.fn(),
  useTasks: vi.fn(),
  useCreateTask: vi.fn(),
  useUpdateTask: vi.fn(),
  useDeleteTask: vi.fn(),
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
  useTasks,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
} from '../lib/queries/index.js'

// The test-setup i18n mock renders keys verbatim, so assertions run on raw
// keys (the Documents/Household page-test convention); member names are real
// data, not translations.

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

// The two-mode roster (ahaqqu/RumaQ#398): ibu (linked owner), ayah (linked
// member), and Adik — the profile-only kid whose chores the parents manage.
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
      birth_date: '2025-03-02',
    },
  ],
}

const KID_CHORE = {
  id: 't1',
  household_id: 'h1',
  title: 'Sapu halaman',
  assignee_member_id: 'm-anak',
  created_by_member_id: 'm-ibu',
  due_date: '2026-11-10',
  recurrence: null,
  status: 'open',
  needs_approval: true,
  approved_by_member_id: null,
  created_at: '2026-11-05 00:00:00',
  updated_at: '2026-11-05 00:00:00',
}

const DONE_CHORE = {
  ...KID_CHORE,
  id: 't2',
  title: 'Rapikan tempat tidur',
  status: 'done',
  due_date: null,
}

const AYAH_ERRAND = {
  ...KID_CHORE,
  id: 't3',
  title: 'Bayar listrik',
  assignee_member_id: 'm-ayah',
  needs_approval: false,
  due_date: null,
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

function renderTasks() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(Tasks, null)
    )
  )
}

function findButton(container, label) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes(label)
  )
}

function findButtons(container, label) {
  return [...container.querySelectorAll('button')].filter((button) =>
    button.textContent.includes(label)
  )
}

// The view-toggle chips are real toggle buttons (#404): aria-pressed carries
// the selected state.
function findChip(container, label) {
  return [...container.querySelectorAll('button[aria-pressed]')].find((chip) =>
    chip.textContent.includes(label)
  )
}

describe('Tasks page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.confirm = vi.fn(() => true)
  })

  it('renders the household board: open/done columns, assignee chips, approval badge', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_OWNER, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useTasks).mockReturnValue({
      data: { tasks: [KID_CHORE, DONE_CHORE] },
      isLoading: false,
    })
    vi.mocked(useCreateTask).mockReturnValue(mutation())
    vi.mocked(useUpdateTask).mockReturnValue(mutation())
    vi.mocked(useDeleteTask).mockReturnValue(mutation())

    const { container } = renderTasks()
    expect(container.textContent).toContain('tasks.openTitle')
    expect(container.textContent).toContain('tasks.doneTitle')
    expect(container.textContent).toContain('tasks.doneCount')
    expect(container.textContent).toContain('Sapu halaman')
    expect(container.textContent).toContain('Rapikan tempat tidur')

    // The assignee chip resolves the PROFILE-ONLY member's display name (the
    // vault's member-chip pattern), and the derived approval state shows.
    expect(container.textContent).toContain('Adik')
    expect(container.textContent).toContain('tasks.awaitingApproval')

    // The owner gets every affordance: complete-on-behalf, approve, edit,
    // delete (the delete button is icon-only — aria-label carries the name).
    expect(findButtons(container, 'tasks.complete')).toHaveLength(1)
    expect(findButton(container, 'tasks.approve')).toBeTruthy()
    expect(findButtons(container, 'tasks.edit')).toHaveLength(2)
    expect(container.querySelectorAll('button[aria-label="tasks.delete"]')).toHaveLength(2)
  })

  it('switches to the per-member "My tasks" filter (mine=1 sugar) and shows its subtitle', async () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u2' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_MEMBER, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useTasks).mockReturnValue({ data: { tasks: [AYAH_ERRAND] }, isLoading: false })
    vi.mocked(useCreateTask).mockReturnValue(mutation())
    vi.mocked(useUpdateTask).mockReturnValue(mutation())
    vi.mocked(useDeleteTask).mockReturnValue(mutation())

    const { container } = renderTasks()
    fireEvent.click(findChip(container, 'tasks.viewMine'))
    await waitFor(() => {
      expect(vi.mocked(useTasks)).toHaveBeenLastCalledWith({ mine: '1', status: 'all' })
    })
    expect(container.textContent).toContain('tasks.mineSubtitle')
    // The unfiltered board was the default view's request.
    expect(vi.mocked(useTasks)).toHaveBeenNthCalledWith(1, {})
  })

  it('creates a task: free-text title, assignee (both roster modes), due date, recurrence', async () => {
    const create = mutation()
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_OWNER, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useTasks).mockReturnValue({ data: { tasks: [] }, isLoading: false })
    vi.mocked(useCreateTask).mockReturnValue(create)
    vi.mocked(useUpdateTask).mockReturnValue(mutation())
    vi.mocked(useDeleteTask).mockReturnValue(mutation())

    const { container } = renderTasks()
    const titleInput = container.querySelector('input[type="text"], input:not([type])')
    fireEvent.change(titleInput, { target: { value: 'Siram tanaman' } })
    const assigneeSelect = container.querySelector('[data-testid="task-assignee-select"]')
    // The picker lists the WHOLE roster — linked members and profile-only
    // kids alike (both are assignable, 0021).
    const options = [...assigneeSelect.querySelectorAll('option')]
    expect(options.some((o) => o.value === 'm-anak' && o.textContent.includes('Adik'))).toBe(true)
    expect(options.some((o) => o.value === 'm-ayah')).toBe(true)
    fireEvent.change(assigneeSelect, { target: { value: 'm-anak' } })
    fireEvent.change(container.querySelector('input[type="date"]'), {
      target: { value: '2026-11-12' },
    })
    const selects = [...container.querySelectorAll('select')]
    const recurrenceSelect = selects.find((s) => !s.dataset.testid)
    fireEvent.change(recurrenceSelect, { target: { value: 'daily' } })

    fireEvent.click(findButton(container, 'tasks.create'))
    await waitFor(() => expect(create.mutate).toHaveBeenCalled())
    expect(create.mutate).toHaveBeenCalledWith(
      {
        title: 'Siram tanaman',
        assignee_member_id: 'm-anak',
        due_date: '2026-11-12',
        recurrence: 'daily',
      },
      expect.any(Object)
    )
  })

  it('lets the owner complete the profile-only kid’s chore on her behalf and approve the done one', () => {
    const update = mutation()
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_OWNER, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useTasks).mockReturnValue({
      data: { tasks: [KID_CHORE, DONE_CHORE] },
      isLoading: false,
    })
    vi.mocked(useCreateTask).mockReturnValue(mutation())
    vi.mocked(useUpdateTask).mockReturnValue(update)
    vi.mocked(useDeleteTask).mockReturnValue(mutation())

    const { container } = renderTasks()
    // Complete on behalf: the owner drives the kid's open chore.
    fireEvent.click(findButton(container, 'tasks.complete'))
    expect(update.mutate).toHaveBeenCalledWith(
      { id: 't1', payload: { status: 'done' } },
      expect.any(Object)
    )
    // Approve: the assigner's acknowledgment rides { approve: true } alone.
    fireEvent.click(findButton(container, 'tasks.approve'))
    expect(update.mutate).toHaveBeenCalledWith(
      { id: 't2', payload: { approve: true } },
      expect.any(Object)
    )
  })

  it('hides manage affordances from an unrelated member but keeps assignee-self completion', () => {
    const update = mutation()
    // Ayah: household role 'member', not the creator — t3 is assigned to him.
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u2' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_MEMBER, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useTasks).mockReturnValue({
      data: { tasks: [KID_CHORE, AYAH_ERRAND] },
      isLoading: false,
    })
    vi.mocked(useCreateTask).mockReturnValue(mutation())
    vi.mocked(useUpdateTask).mockReturnValue(update)
    vi.mocked(useDeleteTask).mockReturnValue(mutation())

    const { container } = renderTasks()
    // The kid's chore (created by ibu, assigned to Adik): ayah gets NO
    // complete/edit/delete affordances — not assignee, not creator, not owner.
    expect(findButtons(container, 'tasks.complete')).toHaveLength(1) // only his own errand
    expect(container.textContent).not.toContain('tasks.edit')
    expect(container.textContent).not.toContain('tasks.delete')

    // His own errand: assignee-self completion, no owner powers.
    fireEvent.click(findButton(container, 'tasks.complete'))
    expect(update.mutate).toHaveBeenCalledWith(
      { id: 't3', payload: { status: 'done' } },
      expect.any(Object)
    )
  })

  it('edits a task inline through the one PATCH endpoint (creator or owner only)', async () => {
    const update = mutation()
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_OWNER, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useTasks).mockReturnValue({ data: { tasks: [KID_CHORE] }, isLoading: false })
    vi.mocked(useCreateTask).mockReturnValue(mutation())
    vi.mocked(useUpdateTask).mockReturnValue(update)
    vi.mocked(useDeleteTask).mockReturnValue(mutation())

    const { container } = renderTasks()
    fireEvent.click(findButton(container, 'tasks.edit'))
    // Scope to the expanded inline form — the create panel's inputs render
    // earlier in the DOM and are not the ones under test.
    const editFields = container.querySelector('[data-testid="task-edit-fields"]')
    const titleInput = [...editFields.querySelectorAll('input')].find(
      (el) => !el.type || el.type === 'text'
    )
    fireEvent.change(titleInput, { target: { value: 'Sapu teras' } })
    fireEvent.click(findButton(container, 'tasks.saveEdit'))

    await waitFor(() => expect(update.mutate).toHaveBeenCalled())
    expect(update.mutate).toHaveBeenCalledWith(
      {
        id: 't1',
        payload: {
          title: 'Sapu teras',
          assignee_member_id: 'm-anak',
          due_date: '2026-11-10',
          recurrence: null,
        },
      },
      expect.any(Object)
    )
  })

  it('deletes a task after confirmation (creator or owner only)', () => {
    const remove = mutation()
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_OWNER, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useTasks).mockReturnValue({ data: { tasks: [KID_CHORE] }, isLoading: false })
    vi.mocked(useCreateTask).mockReturnValue(mutation())
    vi.mocked(useUpdateTask).mockReturnValue(mutation())
    vi.mocked(useDeleteTask).mockReturnValue(remove)

    const { container } = renderTasks()
    fireEvent.click(container.querySelector('button[aria-label="tasks.delete"]'))
    expect(window.confirm).toHaveBeenCalled()
    expect(remove.mutate).toHaveBeenCalledWith({ id: 't1' }, expect.any(Object))
  })

  it('marks overdue against the household calendar (UTC+7 WIB mirror), not UTC', () => {
    // 2026-11-07T17:30:00Z is 2026-11-08 00:30 WIB. A chore due Nov 7 is
    // overdue on the household calendar — but plain-UTC "today" (Nov 7)
    // would keep the highlight off until 07:00 WIB (thermos A3).
    vi.useFakeTimers({ now: new Date('2026-11-07T17:30:00Z') })
    try {
      const overdueChore = { ...KID_CHORE, due_date: '2026-11-07' }
      const futureChore = { ...AYAH_ERRAND, due_date: '2026-11-20' }
      vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
      vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_OWNER, isLoading: false })
      vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
      vi.mocked(useTasks).mockReturnValue({
        data: { tasks: [overdueChore, futureChore] },
        isLoading: false,
      })
      vi.mocked(useCreateTask).mockReturnValue(mutation())
      vi.mocked(useUpdateTask).mockReturnValue(mutation())
      vi.mocked(useDeleteTask).mockReturnValue(mutation())

      const { container } = renderTasks()
      // Scope to spans: the icon-only delete buttons also carry text-danger.
      const dangerSpans = [...container.querySelectorAll('span.text-danger')]
      expect(dangerSpans).toHaveLength(1) // only the overdue chore's due chip
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the empty state when the household has no tasks', () => {
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: HOUSEHOLDS_OWNER, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useTasks).mockReturnValue({ data: { tasks: [] }, isLoading: false })
    vi.mocked(useCreateTask).mockReturnValue(mutation())
    vi.mocked(useUpdateTask).mockReturnValue(mutation())
    vi.mocked(useDeleteTask).mockReturnValue(mutation())

    const { container } = renderTasks()
    // The board renders two columns — both empty when the household has none.
    expect(container.textContent.split('tasks.emptyTitle').length - 1).toBe(2)
  })
})
