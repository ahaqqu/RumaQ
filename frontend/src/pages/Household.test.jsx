import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { Household } from './Household.jsx'

// The page reads ?code= via useSearch (invite links); the global setup's
// router mock does not provide it, so this file extends the mock.
let mockSearch = {}
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router')
  return {
    ...actual,
    useSearch: () => mockSearch,
    useMatches: () => [{ routeId: '/', pathname: '/' }],
    useNavigate: () => vi.fn(),
    Link: ({ children, to, className, ...props }) =>
      React.createElement('a', { ...props, className, href: to, 'data-testid': 'link' }, children),
    Outlet: () => null,
  }
})

vi.mock('../lib/queries/me.js', () => ({
  useMe: vi.fn(),
}))

vi.mock('../lib/queries/index.js', () => ({
  useHouseholds: vi.fn(),
  useCreateHousehold: vi.fn(),
  useRenameHousehold: vi.fn(),
  useActivateHousehold: vi.fn(),
  useHouseholdMembers: vi.fn(),
  useCreateHouseholdMember: vi.fn(),
  useUpdateHouseholdMember: vi.fn(),
  useRemoveHouseholdMember: vi.fn(),
  useLeaveHousehold: vi.fn(),
  useHouseholdInvite: vi.fn(),
  useCreateHouseholdInvite: vi.fn(),
  useJoinHousehold: vi.fn(),
  // The plugin settings catalog section (issue #437) rides the same barrel —
  // the page tests stub it inert; the section's own behavior is pinned in
  // plugins/PluginFeatures.test.jsx.
  usePluginCatalog: vi.fn(() => ({ data: { plugins: [] }, isPending: false, isError: false })),
  useSetPluginEnablement: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isError: false })),
}))

import { useMe } from '../lib/queries/me.js'
import { ApiError } from '../lib/api'
import {
  useHouseholds,
  useCreateHousehold,
  useRenameHousehold,
  useActivateHousehold,
  useHouseholdMembers,
  useCreateHouseholdMember,
  useUpdateHouseholdMember,
  useRemoveHouseholdMember,
  useLeaveHousehold,
  useHouseholdInvite,
  useCreateHouseholdInvite,
  useJoinHousehold,
} from '../lib/queries/index.js'

function mutation(overrides = {}) {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, ...overrides }
}

const OWNER_HOUSEHOLDS = {
  households: [
    { id: 'h1', name: 'Keluarga Putri', role: 'owner', member_count: 2, is_active: true },
    { id: 'h2', name: 'Rumah Bunda', role: 'member', member_count: 3, is_active: false },
  ],
}

const MEMBERS = {
  members: [
    {
      id: 'm1',
      user_id: 'u1',
      has_account: true,
      role: 'owner',
      display_name: null,
      birth_date: null,
      joined_at: '2026-11-01 00:00:00',
      name: 'Alice',
      email: 'alice@example.com',
      picture: null,
    },
    {
      id: 'm2',
      user_id: 'u2',
      has_account: true,
      role: 'member',
      display_name: 'Putri',
      birth_date: '2024-05-01',
      joined_at: '2026-11-02 00:00:00',
      name: 'putri@example.com',
      email: 'putri@example.com',
      picture: null,
    },
  ],
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

function renderHousehold() {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      React.createElement(Household, null)
    )
  )
}

function findButton(container, label) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes(label)
  )
}

// The Add person mode chips are real toggle buttons (#404): aria-pressed
// carries the selected state.
function findChip(container, label) {
  return [...container.querySelectorAll('button[aria-pressed]')].find((chip) =>
    chip.textContent.includes(label)
  )
}

describe('Household', () => {
  beforeEach(() => {
    mockSearch = {}
    vi.mocked(useMe).mockReturnValue({ data: { user: { id: 'u1', name: 'Alice' } } })
    vi.mocked(useHouseholds).mockReturnValue({ data: OWNER_HOUSEHOLDS, isLoading: false })
    vi.mocked(useHouseholdMembers).mockReturnValue({ data: MEMBERS, isLoading: false })
    vi.mocked(useHouseholdInvite).mockReturnValue({ data: { invite: null }, isLoading: false })
    vi.mocked(useCreateHousehold).mockReturnValue(mutation())
    vi.mocked(useRenameHousehold).mockReturnValue(mutation())
    vi.mocked(useActivateHousehold).mockReturnValue(mutation())
    vi.mocked(useCreateHouseholdMember).mockReturnValue(mutation())
    vi.mocked(useUpdateHouseholdMember).mockReturnValue(mutation())
    vi.mocked(useRemoveHouseholdMember).mockReturnValue(mutation())
    vi.mocked(useLeaveHousehold).mockReturnValue(mutation())
    vi.mocked(useCreateHouseholdInvite).mockReturnValue(mutation())
    vi.mocked(useJoinHousehold).mockReturnValue(mutation())
  })

  it('shows the identity card with the active household, its size, and the members', () => {
    const { container } = renderHousehold()
    expect(container.textContent).toContain('Keluarga Putri')
    expect(container.textContent).toContain('household.memberCount')
    expect(container.textContent).toContain('Putri')
    expect(container.textContent).toContain('alice@example.com')
    // Roles ride as chips; the owner chip marks Alice.
    expect(container.textContent).toContain('household.roleOwner')
    expect(container.textContent).toContain('household.roleMember')
  })

  it('shows the Add person panel only to owners', () => {
    const { container } = renderHousehold()
    expect(container.textContent).toContain('household.addPersonTitle')

    vi.mocked(useHouseholds).mockReturnValue({
      data: {
        households: [
          { id: 'h1', name: 'Keluarga Putri', role: 'member', member_count: 2, is_active: true },
        ],
      },
      isLoading: false,
    })
    const memberView = renderHousehold()
    expect(memberView.container.textContent).not.toContain('household.addPersonTitle')
  })

  it('defaults the Add person flow to the invite mode (the current flow)', () => {
    const { container } = renderHousehold()
    expect(container.textContent).toContain('household.inviteHint')
    expect(findButton(container, 'household.inviteGenerate')).toBeTruthy()
    // The profile form is not open in the invite mode.
    expect(container.textContent).not.toContain('household.profileHint')
  })

  it('adds a profile-only member through the Add person profile mode', () => {
    const createMemberMutation = mutation()
    vi.mocked(useCreateHouseholdMember).mockReturnValue(createMemberMutation)
    const { container } = renderHousehold()
    // Mode chips are toggle buttons: invite starts pressed, profile flips it.
    expect(findChip(container, 'household.modeInvite').getAttribute('aria-pressed')).toBe('true')
    expect(findChip(container, 'household.modeProfile').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(findChip(container, 'household.modeProfile'))
    expect(findChip(container, 'household.modeInvite').getAttribute('aria-pressed')).toBe('false')
    expect(findChip(container, 'household.modeProfile').getAttribute('aria-pressed')).toBe('true')
    const nameInput = container.querySelector('input[maxlength="80"]')
    fireEvent.change(nameInput, { target: { value: '  Adik  ' } })
    const dateInput = container.querySelector('input[type="date"]')
    fireEvent.change(dateInput, { target: { value: '2025-03-02' } })
    fireEvent.click(findButton(container, 'household.profileAdd'))
    expect(createMemberMutation.mutate).toHaveBeenCalledWith(
      { display_name: 'Adik', birth_date: '2025-03-02' },
      expect.anything()
    )
  })

  it('keeps the Add-profile draft separate from the member edit form', () => {
    const { container } = renderHousehold()
    // Type into the self-row edit form, then close it.
    fireEvent.click(findButton(container, 'household.editProfile'))
    const editInput = container.querySelector('input[maxlength="80"]')
    fireEvent.change(editInput, { target: { value: 'Mama' } })
    fireEvent.click(findButton(container, 'household.cancel'))
    // The Add-profile form starts empty — a closed edit must never prefill
    // another member's identity into Add (one click = duplicate person).
    fireEvent.click(findChip(container, 'household.modeProfile'))
    const addInput = container.querySelector('input[maxlength="80"]')
    expect(addInput.value).toBe('')
    expect(addInput).not.toBe(editInput)
  })

  it('renders profile-only members with the no-account chip and no email line', () => {
    vi.mocked(useHouseholdMembers).mockReturnValue({
      data: {
        members: [
          ...MEMBERS.members,
          {
            id: 'm9',
            user_id: null,
            has_account: false,
            role: 'member',
            display_name: 'Adik',
            birth_date: '2025-03-02',
            joined_at: '2026-11-03 00:00:00',
            name: null,
            email: null,
            picture: null,
          },
        ],
      },
      isLoading: false,
    })
    const { container } = renderHousehold()
    expect(container.textContent).toContain('Adik')
    expect(container.textContent).toContain('household.noAccount')
  })

  it('generates an invite code when the owner asks for one', () => {
    const inviteMutation = mutation()
    vi.mocked(useCreateHouseholdInvite).mockReturnValue(inviteMutation)
    const { container } = renderHousehold()
    fireEvent.click(findButton(container, 'household.inviteGenerate'))
    expect(inviteMutation.mutate).toHaveBeenCalled()
  })

  it('shows the live code with its expiry when one exists', () => {
    vi.mocked(useHouseholdInvite).mockReturnValue({
      data: { invite: { id: 'inv1', code: 'ABC2345678', expires_at: '2026-11-10 00:00:00' } },
      isLoading: false,
    })
    const { getByTestId, container } = renderHousehold()
    expect(getByTestId('invite-code').textContent).toBe('ABC2345678')
    expect(container.textContent).toContain('household.inviteExpires')
    expect(container.textContent).toContain('household.inviteRegenerate')
  })

  // Link-later (#397): the owner can mark the invite for one profile-only
  // member; the selector lists ONLY has_account=false roster rows.
  it('hides the invite target selector when every member has an account', () => {
    const { container } = renderHousehold()
    expect(container.querySelector('[data-testid="invite-target-select"]')).toBeNull()
  })

  it('lists only profile-only members in the invite target selector', () => {
    vi.mocked(useHouseholdMembers).mockReturnValue({
      data: {
        members: [
          ...MEMBERS.members,
          {
            id: 'm9',
            user_id: null,
            has_account: false,
            role: 'member',
            display_name: 'Adik',
            birth_date: '2025-03-02',
            joined_at: '2026-11-03 00:00:00',
            name: null,
            email: null,
            picture: null,
          },
        ],
      },
      isLoading: false,
    })
    const { container } = renderHousehold()
    const select = container.querySelector('[data-testid="invite-target-select"]')
    expect(select).toBeTruthy()
    const options = [...select.querySelectorAll('option')]
    // The no-target option plus exactly the profile-only rows.
    expect(options).toHaveLength(2)
    expect(options[0].value).toBe('')
    expect(options[0].textContent).toContain('household.inviteTargetNone')
    expect(options[1].value).toBe('m9')
    expect(options[1].textContent).toBe('Adik')
  })

  it('generates a marked invite when a member is selected and a plain one otherwise', () => {
    vi.mocked(useHouseholdMembers).mockReturnValue({
      data: {
        members: [
          ...MEMBERS.members,
          {
            id: 'm9',
            user_id: null,
            has_account: false,
            role: 'member',
            display_name: 'Adik',
            birth_date: null,
            joined_at: '2026-11-03 00:00:00',
            name: null,
            email: null,
            picture: null,
          },
        ],
      },
      isLoading: false,
    })
    const inviteMutation = mutation()
    vi.mocked(useCreateHouseholdInvite).mockReturnValue(inviteMutation)
    const { container } = renderHousehold()

    // No selection: the POST stays bodyless — today's plain invite.
    fireEvent.click(findButton(container, 'household.inviteGenerate'))
    expect(inviteMutation.mutate).toHaveBeenLastCalledWith(undefined, expect.anything())

    // Picking Adik marks the invite for her member id.
    const select = container.querySelector('[data-testid="invite-target-select"]')
    fireEvent.change(select, { target: { value: 'm9' } })
    fireEvent.click(findButton(container, 'household.inviteGenerate'))
    expect(inviteMutation.mutate).toHaveBeenLastCalledWith(
      { target_member_id: 'm9' },
      expect.anything()
    )
  })

  it('marks a targeted invite with For: <display_name> in the owner display', () => {
    vi.mocked(useHouseholdMembers).mockReturnValue({
      data: {
        members: [
          ...MEMBERS.members,
          {
            id: 'm9',
            user_id: null,
            has_account: false,
            role: 'member',
            display_name: 'Adik',
            birth_date: null,
            joined_at: '2026-11-03 00:00:00',
            name: null,
            email: null,
            picture: null,
          },
        ],
      },
      isLoading: false,
    })
    vi.mocked(useHouseholdInvite).mockReturnValue({
      data: {
        invite: {
          id: 'inv1',
          code: 'ABC2345678',
          expires_at: '2026-11-10 00:00:00',
          target_member_id: 'm9',
          has_target: true,
        },
      },
      isLoading: false,
    })
    const { container } = renderHousehold()
    expect(container.textContent).toContain('household.inviteFor')
    expect(container.textContent).toContain('Adik')
  })

  it('shows no For mark for a plain invite', () => {
    vi.mocked(useHouseholdInvite).mockReturnValue({
      data: {
        invite: {
          id: 'inv1',
          code: 'ABC2345678',
          expires_at: '2026-11-10 00:00:00',
          target_member_id: null,
          has_target: false,
        },
      },
      isLoading: false,
    })
    const { container } = renderHousehold()
    expect(container.textContent).not.toContain('household.inviteFor')
  })

  it('maps a 400 on the invite endpoint to the invalid-target copy', () => {
    vi.mocked(useCreateHouseholdInvite).mockReturnValue({
      mutate: vi.fn((_payload, opts) => opts?.onError?.(new ApiError('fail', 400))),
      isPending: false,
    })
    const { container } = renderHousehold()
    fireEvent.click(findButton(container, 'household.inviteGenerate'))
    expect(container.textContent).toContain('household.inviteInvalidTarget')
  })

  it('maps a 409 on join to the target-conflict copy, not the last-owner rule', () => {
    const joinMutation = {
      mutate: vi.fn((_code, opts) => opts?.onError?.(new ApiError('fail', 409))),
      isPending: false,
    }
    vi.mocked(useJoinHousehold).mockReturnValue(joinMutation)
    const { container } = renderHousehold()
    const input = container.querySelector('input[aria-label="household.joinPlaceholder"]')
    fireEvent.change(input, { target: { value: 'ABC2345678' } })
    fireEvent.click(findButton(container, 'household.joinAction'))
    expect(container.textContent).toContain('household.joinConflict')
    expect(container.textContent).not.toContain('household.lastOwnerRemoveBlocked')
  })

  it('copies the wrapped invite link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    vi.mocked(useHouseholdInvite).mockReturnValue({
      data: { invite: { id: 'inv1', code: 'ABC2345678', expires_at: '' } },
      isLoading: false,
    })
    const { container } = renderHousehold()
    fireEvent.click(findButton(container, 'household.inviteCopy'))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/household?code=ABC2345678`)
    )
  })

  it('joins by code, trimming the input', () => {
    const joinMutation = mutation()
    vi.mocked(useJoinHousehold).mockReturnValue(joinMutation)
    const { container } = renderHousehold()
    const input = container.querySelector('input[aria-label="household.joinPlaceholder"]')
    fireEvent.change(input, { target: { value: '  ABC2345678  ' } })
    fireEvent.click(findButton(container, 'household.joinAction'))
    expect(joinMutation.mutate).toHaveBeenCalledWith('ABC2345678', expect.anything())
  })

  it('pre-fills the join code from an invite link (?code=)', () => {
    mockSearch = { code: 'XYZ2345678' }
    const { container } = renderHousehold()
    const input = container.querySelector('input[aria-label="household.joinPlaceholder"]')
    expect(input.value).toBe('XYZ2345678')
  })

  it('lets a member edit their own profile fields', () => {
    const updateMutation = mutation()
    vi.mocked(useUpdateHouseholdMember).mockReturnValue(updateMutation)
    const { container } = renderHousehold()
    // Alice's own row: first Edit profile button belongs to the self row.
    fireEvent.click(findButton(container, 'household.editProfile'))
    const nameInput = container.querySelector('input[maxlength="80"]')
    fireEvent.change(nameInput, { target: { value: 'Mama' } })
    fireEvent.click(findButton(container, 'household.saveProfile'))
    // Member-addressed edits key on the surrogate member id (#388).
    expect(updateMutation.mutate).toHaveBeenCalledWith(
      { memberId: 'm1', payload: { display_name: 'Mama', birth_date: '' } },
      expect.anything()
    )
  })

  it('removes a member after confirmation (owner)', () => {
    window.confirm = vi.fn(() => true)
    const removeMutation = mutation()
    vi.mocked(useRemoveHouseholdMember).mockReturnValue(removeMutation)
    const { container } = renderHousehold()
    const removeButton = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'household.remove'
    )
    expect(removeButton).toBeTruthy()
    fireEvent.click(removeButton)
    expect(window.confirm).toHaveBeenCalled()
    expect(removeMutation.mutate).toHaveBeenCalledWith(
      { id: 'h1', memberId: 'm2', selfUserId: 'u2' },
      expect.anything()
    )
  })

  it('switches the active household from the households list', () => {
    const activateMutation = mutation()
    vi.mocked(useActivateHousehold).mockReturnValue(activateMutation)
    const { container } = renderHousehold()
    fireEvent.click(findButton(container, 'household.switchTo'))
    expect(activateMutation.mutate).toHaveBeenCalledWith('h2', expect.anything())
  })

  it('creates a household from the name input', () => {
    const createMutation = mutation()
    vi.mocked(useCreateHousehold).mockReturnValue(createMutation)
    const { container } = renderHousehold()
    const input = container.querySelector('input[maxlength="80"]:not([type="date"])')
    fireEvent.change(input, { target: { value: 'Rumah Kedua' } })
    fireEvent.click(findButton(container, 'household.createAction'))
    expect(createMutation.mutate).toHaveBeenCalledWith('Rumah Kedua', expect.anything())
  })

  it('leaves the active household after confirmation', () => {
    window.confirm = vi.fn(() => true)
    const leaveMutation = mutation()
    vi.mocked(useLeaveHousehold).mockReturnValue(leaveMutation)
    const { container } = renderHousehold()
    fireEvent.click(findButton(container, 'household.leave'))
    expect(leaveMutation.mutate).toHaveBeenCalledWith('h1', expect.anything())
  })

  it('maps a 409 to the last-owner rule message', () => {
    window.confirm = vi.fn(() => true)
    // The page maps err.status to copy via the real ApiError class.
    vi.mocked(useLeaveHousehold).mockReturnValue({
      mutate: vi.fn((_id, opts) => opts?.onError?.(new ApiError('fail', 409))),
      isPending: false,
    })
    const { container } = renderHousehold()
    fireEvent.click(findButton(container, 'household.leave'))
    expect(container.textContent).toContain('household.lastOwnerRemoveBlocked')
  })

  it('shows skeletons while loading', () => {
    vi.mocked(useHouseholds).mockReturnValue({ data: undefined, isLoading: true })
    const { container } = renderHousehold()
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })
})
