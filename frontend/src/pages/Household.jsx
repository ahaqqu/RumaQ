import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearch } from '@tanstack/react-router'
import { useMe } from '../lib/queries/me.js'
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
import { ApiError } from '../lib/api'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { Button } from '../components/Button.jsx'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import {
  IconUsers,
  IconPlus,
  IconTrash,
  IconCopy,
  IconRefresh,
  IconCheck,
} from '../components/icons.jsx'
import { cn } from '../lib/cn.js'

// Error vocabulary mirrors the backend's households app: the (endpoint,
// status) pair picks the copy, never the raw server string. A 400 only means
// "invalid invite code" on the join endpoint and "invalid target" on the
// invite endpoint — other mutations get the generic message instead of an
// invite-specific claim (review A10). The join endpoint's 409 is the
// link-later target conflict (#397), not the last-owner rule.
function householdErrorKey(error, endpoint) {
  const status = error instanceof ApiError ? error.status : undefined
  if (status === 400) {
    if (endpoint === 'join') return 'household.joinInvalid'
    if (endpoint === 'invite') return 'household.inviteInvalidTarget'
    return 'household.errorGeneric'
  }
  if (status === 403) return 'household.onlyOwners'
  if (status === 409)
    return endpoint === 'join' ? 'household.joinConflict' : 'household.lastOwnerRemoveBlocked'
  return 'household.errorGeneric'
}

function formatDate(value, language) {
  if (!value) return null
  const date = new Date(String(value).includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function Avatar({ picture, name, size = 'md' }) {
  const [imgError, setImgError] = useState(false)
  const box = size === 'md' ? 'w-10 h-10' : 'w-8 h-8'
  if (picture && !imgError) {
    return (
      <img
        className={cn(box, 'rounded-xl object-cover shrink-0')}
        src={picture}
        alt=""
        onError={() => setImgError(true)}
      />
    )
  }
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  return (
    <div
      className={cn(
        box,
        'rounded-xl grid place-items-center bg-surface-inset text-text font-semibold shrink-0'
      )}
      aria-hidden="true"
    >
      {initial}
    </div>
  )
}

function InlineField({ label, ...props }) {
  return (
    <label className="flex flex-col gap-1 text-sm min-w-0">
      <span className="text-text-muted">{label}</span>
      <input className="w-full" {...props} />
    </label>
  )
}

// One member row: identity, role chip, joined date, and the profile/remove
// affordances (profile: self always, owners for anyone; remove: owners only).
// Profile-only members (#388, has_account=false) carry a "no account" chip —
// they have no email/picture, display_name is their identity.
function MemberRow({ member, isSelf, canRemove, onEdit, onRemove, editOpen, children, language }) {
  const { t, i18n } = useTranslation()
  const name = member.display_name || member.name || member.email || member.user_id
  return (
    <div className="px-5 py-4 border-b border-border last:border-b-0">
      <div className="flex items-center gap-3">
        <Avatar picture={member.picture} name={member.display_name || member.name} />
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">
            {name}
            {isSelf && <span className="text-text-muted font-normal"> · {t('household.you')}</span>}
          </div>
          <div className="text-sm text-text-muted truncate">
            {member.email}
            {member.email && member.joined_at && ' · '}
            {member.joined_at &&
              t('household.joined', {
                date: formatDate(member.joined_at, i18n.language) ?? member.joined_at,
              })}
          </div>
        </div>
        <Chip variant={member.role === 'owner' ? 'accent' : 'default'}>
          {member.role === 'owner' ? t('household.roleOwner') : t('household.roleMember')}
        </Chip>
        {member.has_account === false && <Chip>{t('household.noAccount')}</Chip>}
        <div className="flex items-center gap-1.5 shrink-0">
          {(isSelf || canRemove) && (
            <Button size="sm" variant="ghost" onClick={onEdit} aria-expanded={editOpen}>
              {t('household.editProfile')}
            </Button>
          )}
          {canRemove && !isSelf && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onRemove}
              aria-label={t('household.remove')}
              className="text-danger"
            >
              <IconTrash size={16} />
            </Button>
          )}
        </div>
      </div>
      {editOpen && <div className="mt-3 flex flex-wrap items-end gap-3">{children}</div>}
      {/* display_name/birth_date surface when set — the per-member profile
          fields the future age-based features build on. */}
      {(member.display_name || member.birth_date) && !editOpen && (
        <div className="mt-2 text-xs text-text-muted">
          {member.birth_date && (
            <span>
              {t('household.birthDate')}:{' '}
              {formatDate(member.birth_date, language) ?? member.birth_date}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function Household() {
  const { t, i18n } = useTranslation()
  const { data: me } = useMe()
  const { code: joinCodeParam } = useSearch({ strict: false }) ?? {}

  const { data: householdsData, isLoading } = useHouseholds()
  const createHousehold = useCreateHousehold()
  const renameHousehold = useRenameHousehold()
  const activateHousehold = useActivateHousehold()
  const leaveHousehold = useLeaveHousehold()
  const joinHousehold = useJoinHousehold()

  const households = householdsData?.households ?? []
  const active = households.find((h) => h.is_active) ?? null
  const activeId = active?.id
  const isOwner = active?.role === 'owner'
  const userId = me?.user?.id

  const { data: membersData, isLoading: membersLoading } = useHouseholdMembers(activeId)
  const members = membersData?.members ?? []
  const createMember = useCreateHouseholdMember(activeId)
  const updateMember = useUpdateHouseholdMember(activeId)
  const removeMember = useRemoveHouseholdMember()

  const { data: inviteData } = useHouseholdInvite(isOwner ? activeId : undefined)
  const createInvite = useCreateHouseholdInvite(activeId)
  const invite = inviteData?.invite ?? null
  const [copied, setCopied] = useState(false)

  // Add person (#388): two modes — invite an existing user (the share-code
  // flow) or add a profile-only member with no account (a toddler). The Add
  // form keeps its OWN draft: sharing it with the per-member edit form would
  // prefill Add with another member's identity after an edit is closed.
  const [addMode, setAddMode] = useState('invite')
  const [addProfileDraft, setAddProfileDraft] = useState({ display_name: '', birth_date: '' })
  // Link-later (#397): an owner can mark the invite for one profile-only
  // member — redeeming it attaches the redeemer's account to that row instead
  // of creating a new member. Empty selection = today's plain invite.
  const [inviteTargetId, setInviteTargetId] = useState('')
  const profileOnlyMembers = members.filter((m) => m.has_account === false)

  // Member-addressed edits key on the surrogate member id — profile-only
  // members have no user_id.
  const [editingMemberId, setEditingMemberId] = useState(null)
  const [editDraft, setEditDraft] = useState({ display_name: '', birth_date: '' })
  // Rename is an inline field in the identity card (review B4) — no
  // window.prompt; the remove/leave confirms stay as noted debt.
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [joinCode, setJoinCode] = useState(typeof joinCodeParam === 'string' ? joinCodeParam : '')
  const [newHouseholdName, setNewHouseholdName] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [actionError, setActionError] = useState(null)

  const memberCount = active?.member_count ?? members.length
  // The backend 409s on OWNER count, not member count — the warning and the
  // rule must key on the same number (review A9): the sole owner of a
  // 4-person household is blocked from leaving just as much as a solo one.
  const ownerCount = members.filter((m) => m.role === 'owner').length

  const openEdit = (member) => {
    setEditingMemberId(member.id)
    setEditDraft({
      display_name: member.display_name ?? '',
      birth_date: member.birth_date ?? '',
    })
  }

  const saveProfile = () => {
    updateMember.mutate(
      { memberId: editingMemberId, payload: editDraft },
      {
        onSuccess: () => {
          setEditingMemberId(null)
          setActionError(null)
        },
        onError: (err) => setActionError(t(householdErrorKey(err))),
      }
    )
  }

  const addProfile = () => {
    const displayName = addProfileDraft.display_name.trim()
    if (!displayName) return
    createMember.mutate(
      { display_name: displayName, birth_date: addProfileDraft.birth_date || null },
      {
        onSuccess: (data) => {
          setAddProfileDraft({ display_name: '', birth_date: '' })
          setFeedback(
            t('household.profileAdded', { name: data?.member?.display_name ?? displayName })
          )
          setActionError(null)
        },
        onError: (err) => setActionError(t(householdErrorKey(err))),
      }
    )
  }

  const confirmRemove = (member) => {
    const name = member.display_name || member.name || member.email
    if (!window.confirm(t('household.removeConfirm', { name }))) return
    removeMember.mutate(
      // selfUserId rides along so the hook can sweep the whole cache when a
      // member linked to the caller is removed (profile-only rows never are).
      { id: activeId, memberId: member.id, selfUserId: member.user_id },
      { onError: (err) => setActionError(t(householdErrorKey(err))) }
    )
  }

  const confirmLeave = () => {
    if (!active) return
    if (!window.confirm(t('household.leaveConfirm', { name: active.name }))) return
    leaveHousehold.mutate(activeId, {
      onError: (err) => setActionError(t(householdErrorKey(err))),
    })
  }

  const join = () => {
    const trimmed = joinCode.trim()
    if (!trimmed) return
    joinHousehold.mutate(trimmed, {
      onSuccess: (data) => {
        setJoinCode('')
        const name = data?.household?.name
        setFeedback(
          t(data?.already_member ? 'household.joinAlready' : 'household.joinSuccess', { name })
        )
        setActionError(null)
      },
      onError: (err) => {
        setFeedback(null)
        setActionError(t(householdErrorKey(err, 'join')))
      },
    })
  }

  const create = () => {
    const name = newHouseholdName.trim()
    if (!name) return
    createHousehold.mutate(name, {
      onSuccess: () => {
        setNewHouseholdName('')
        setActionError(null)
      },
      onError: (err) => setActionError(t(householdErrorKey(err))),
    })
  }

  const rename = () => {
    if (!active) return
    const name = renameDraft.trim()
    if (!name || name === active.name) return
    renameHousehold.mutate(
      { id: activeId, name },
      {
        onSuccess: () => {
          setRenaming(false)
          setActionError(null)
        },
        onError: (err) => setActionError(t(householdErrorKey(err))),
      }
    )
  }

  const activate = (id) => {
    activateHousehold.mutate(id, {
      onSuccess: () => {
        const household = households.find((h) => h.id === id)
        setFeedback(t('household.switched', { name: household?.name ?? '' }))
        setActionError(null)
      },
      onError: (err) => setActionError(t(householdErrorKey(err))),
    })
  }

  const inviteLink = useMemo(
    () => (invite ? `${window.location.origin}/household?code=${invite.code}` : null),
    [invite]
  )

  // Generates (or rotates) the code. With a member picked in the selector the
  // invite is marked for them ({ target_member_id }); without one the payload
  // is undefined and the POST stays bodyless (the plain invite, #397). A 400
  // here is the invalid-target refusal, not the generic copy.
  const generateInvite = () => {
    createInvite.mutate(inviteTargetId ? { target_member_id: inviteTargetId } : undefined, {
      onSuccess: () => setActionError(null),
      onError: (err) => setActionError(t(householdErrorKey(err, 'invite'))),
    })
  }

  const copyInvite = async () => {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
    } catch {
      // Clipboard may be unavailable (permissions / insecure context); the
      // code itself is visible right above, so copying is a convenience.
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <SkeletonRows n={4} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {feedback && (
        <div
          role="status"
          className="px-4 py-3 rounded-lg bg-ok-soft text-sm text-text flex items-center gap-2"
        >
          <IconCheck size={16} className="text-ok" /> {feedback}
        </div>
      )}
      {actionError && (
        <div role="alert" className="px-4 py-3 rounded-lg bg-danger-soft text-sm text-danger">
          {actionError}
        </div>
      )}

      {/* Identity card: the same household the sidebar shows, with its size. */}
      <Panel className="p-5">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl grid place-items-center bg-accent-soft text-accent-hover shrink-0">
            <IconUsers size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-text truncate">
              {active ? active.name : t('household.title')}
            </h2>
            <div className="text-sm text-text-muted">
              {t('household.memberCount', { count: memberCount })}
              {active && (
                <Chip variant="default" className="ml-2">
                  {isOwner ? t('household.roleOwner') : t('household.roleMember')}
                </Chip>
              )}
            </div>
          </div>
          {isOwner &&
            (renaming ? (
              <div className="flex flex-wrap items-end gap-2">
                <InlineField
                  label={t('household.renamePrompt')}
                  value={renameDraft}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={rename}
                    disabled={renameHousehold.isPending || !renameDraft.trim()}
                  >
                    {t('household.renameSave')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                    {t('household.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setRenameDraft(active?.name ?? '')
                  setRenaming(true)
                }}
              >
                {t('household.rename')}
              </Button>
            ))}
        </div>
      </Panel>

      {/* Members */}
      <Panel>
        <PanelHead>
          <div>
            <div className="font-semibold">{t('household.title')}</div>
            <div className="text-sm text-text-muted mt-0.5">{t('household.subtitle')}</div>
          </div>
          <Chip variant="loc">{t('household.memberCount', { count: memberCount })}</Chip>
        </PanelHead>
        {membersLoading ? (
          <PanelBody>
            <SkeletonRows n={3} />
          </PanelBody>
        ) : members.length === 0 ? (
          <PanelBody>
            <EmptyState
              icon={IconUsers}
              title={t('household.title')}
              desc={t('household.subtitle')}
            />
          </PanelBody>
        ) : (
          <div>
            {members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                isSelf={member.user_id !== null && member.user_id === userId}
                canRemove={isOwner}
                editOpen={editingMemberId === member.id}
                language={i18n.language}
                onEdit={() =>
                  editingMemberId === member.id ? setEditingMemberId(null) : openEdit(member)
                }
                onRemove={() => confirmRemove(member)}
              >
                <InlineField
                  label={t('household.displayName')}
                  value={editDraft.display_name}
                  maxLength={80}
                  placeholder={t('household.displayNamePlaceholder')}
                  onChange={(e) => setEditDraft((d) => ({ ...d, display_name: e.target.value }))}
                />
                <InlineField
                  label={t('household.birthDate')}
                  type="date"
                  value={editDraft.birth_date}
                  onChange={(e) => setEditDraft((d) => ({ ...d, birth_date: e.target.value }))}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveProfile} disabled={updateMember.isPending}>
                    {t('household.saveProfile')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingMemberId(null)}>
                    {t('household.cancel')}
                  </Button>
                </div>
              </MemberRow>
            ))}
          </div>
        )}
      </Panel>

      {/* Add person (owners) — two modes (#388): invite an existing user
          (the current share-code flow) or add a profile-only member with no
          account. Mode chips act as the segmented control. */}
      {isOwner && (
        <Panel>
          <PanelHead>
            <div className="font-semibold">{t('household.addPersonTitle')}</div>
            {/* Same toggle pattern as the review/prices filter chips: a
                labelled group of pressed-state chips, no tab semantics. */}
            <div
              role="group"
              aria-label={t('household.addPersonTitle')}
              className="flex items-center gap-2"
            >
              <Chip
                variant="filter"
                pressed={addMode === 'invite'}
                aria-pressed={addMode === 'invite'}
                onClick={() => setAddMode('invite')}
              >
                {t('household.modeInvite')}
              </Chip>
              <Chip
                variant="filter"
                pressed={addMode === 'profile'}
                aria-pressed={addMode === 'profile'}
                onClick={() => setAddMode('profile')}
              >
                {t('household.modeProfile')}
              </Chip>
            </div>
          </PanelHead>
          {addMode === 'profile' ? (
            <PanelBody className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">{t('household.profileHint')}</p>
              <div className="flex flex-wrap items-end gap-3">
                <InlineField
                  label={t('household.displayName')}
                  value={addProfileDraft.display_name}
                  maxLength={80}
                  placeholder={t('household.displayNamePlaceholder')}
                  onChange={(e) =>
                    setAddProfileDraft((d) => ({ ...d, display_name: e.target.value }))
                  }
                />
                <InlineField
                  label={t('household.birthDate')}
                  type="date"
                  value={addProfileDraft.birth_date}
                  onChange={(e) =>
                    setAddProfileDraft((d) => ({ ...d, birth_date: e.target.value }))
                  }
                />
                <Button
                  size="sm"
                  onClick={addProfile}
                  disabled={createMember.isPending || !addProfileDraft.display_name.trim()}
                >
                  <IconPlus size={15} /> {t('household.profileAdd')}
                </Button>
              </div>
            </PanelBody>
          ) : (
            <PanelBody className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">{t('household.inviteHint')}</p>
              {/* Link-later (#397): mark the invite for one profile-only
                  member. The selector lists ONLY has_account=false roster
                  rows — linked members have nothing to attach. */}
              {profileOnlyMembers.length > 0 && (
                <>
                  <label className="flex flex-col gap-1 text-sm max-w-[360px]">
                    <span className="text-text-muted">{t('household.inviteTargetLabel')}</span>
                    <select
                      className="w-full"
                      data-testid="invite-target-select"
                      value={inviteTargetId}
                      onChange={(e) => setInviteTargetId(e.target.value)}
                    >
                      <option value="">{t('household.inviteTargetNone')}</option>
                      {profileOnlyMembers.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name || m.name || m.email || '?'}
                        </option>
                      ))}
                    </select>
                  </label>
                  {inviteTargetId && (
                    <p className="text-sm text-text-muted">{t('household.inviteTargetHint')}</p>
                  )}
                </>
              )}
              {invite ? (
                <div className="flex flex-wrap items-center gap-3">
                  <code
                    className="px-4 py-2.5 rounded-lg bg-surface-inset text-lg font-bold tracking-[0.2em] select-all"
                    data-testid="invite-code"
                  >
                    {invite.code}
                  </code>
                  {invite.has_target && (
                    <Chip variant="accent">
                      {t('household.inviteFor', {
                        name:
                          members.find((m) => m.id === invite.target_member_id)?.display_name ?? '',
                      })}
                    </Chip>
                  )}
                  <Button size="sm" variant="secondary" onClick={copyInvite}>
                    {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                    {copied ? t('household.inviteCopied') : t('household.inviteCopy')}
                  </Button>
                  <span className="text-xs text-text-muted">
                    {t('household.inviteExpires', {
                      date: formatDate(invite.expires_at, i18n.language) ?? invite.expires_at,
                    })}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={generateInvite}
                    disabled={createInvite.isPending}
                  >
                    <IconRefresh size={15} /> {t('household.inviteRegenerate')}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-text-muted">{t('household.inviteNone')}</span>
                  <Button size="sm" onClick={generateInvite} disabled={createInvite.isPending}>
                    <IconPlus size={15} /> {t('household.inviteGenerate')}
                  </Button>
                </div>
              )}
            </PanelBody>
          )}
        </Panel>
      )}

      {/* Join by code — the other half of the invite flow; ?code= pre-fills. */}
      <Panel>
        <PanelHead>
          <div className="font-semibold">{t('household.joinTitle')}</div>
        </PanelHead>
        <PanelBody className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">{t('household.joinHint')}</p>
          <div className="flex flex-wrap gap-2 max-w-[360px]">
            <input
              className="flex-1 min-w-0"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && join()}
              placeholder={t('household.joinPlaceholder')}
              aria-label={t('household.joinPlaceholder')}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={join}
              disabled={joinHousehold.isPending || !joinCode.trim()}
              className="shrink-0"
            >
              {t('household.joinAction')}
            </Button>
          </div>
        </PanelBody>
      </Panel>

      {/* All households: switch active, create another. */}
      <Panel>
        <PanelHead>
          <div className="font-semibold">{t('household.yourHouseholds')}</div>
        </PanelHead>
        <div>
          {households.map((household) => (
            <div
              key={household.id}
              className="flex items-center gap-3 px-5 py-4 border-b border-border last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{household.name}</div>
                <div className="text-sm text-text-muted">
                  {t('household.memberCount', { count: household.member_count })}
                </div>
              </div>
              {household.is_active ? (
                <Chip variant="accent">{t('household.active')}</Chip>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => activate(household.id)}
                  disabled={activateHousehold.isPending}
                >
                  {t('household.switchTo')}
                </Button>
              )}
            </div>
          ))}
        </div>
        <PanelBody className="border-t border-border flex flex-col gap-2">
          <div className="text-sm font-medium">{t('household.createTitle')}</div>
          <p className="text-sm text-text-muted">{t('household.createHint')}</p>
          <div className="flex flex-wrap gap-2 max-w-[360px]">
            <input
              className="flex-1 min-w-0"
              value={newHouseholdName}
              onChange={(e) => setNewHouseholdName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder={t('household.createPlaceholder')}
              aria-label={t('household.createPlaceholder')}
              maxLength={80}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={create}
              disabled={createHousehold.isPending || !newHouseholdName.trim()}
              className="shrink-0"
            >
              <IconPlus size={15} /> {t('household.createAction')}
            </Button>
          </div>
        </PanelBody>
      </Panel>

      {/* Leave (danger zone). The backend 409s the last owner; the button
          stays visible so the rule is discoverable, the error explains it. */}
      {active && (
        <Panel className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium text-danger">{t('household.leave')}</div>
              {isOwner && ownerCount <= 1 && (
                <div className="text-sm text-text-muted mt-0.5">
                  {t('household.lastOwnerWarning')}
                </div>
              )}
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={confirmLeave}
              disabled={leaveHousehold.isPending}
            >
              {t('household.leave')}
            </Button>
          </div>
        </Panel>
      )}
    </div>
  )
}
