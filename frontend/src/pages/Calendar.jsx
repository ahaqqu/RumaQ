import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMe } from '../lib/queries/me.js'
import {
  useHouseholds,
  useHouseholdMembers,
  useCalendar,
  useCreateCalendarEvent,
  useUpdateCalendarEvent,
  useDeleteCalendarEvent,
} from '../lib/queries/index.js'
import { ApiError } from '../lib/api'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { Button } from '../components/Button.jsx'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import {
  IconCalendarBlank,
  IconPlus,
  IconTrash,
  IconClock,
  IconArrowLeft,
  IconArrowRight,
  IconKey,
} from '../components/icons.jsx'
import { cn } from '../lib/cn.js'
import { isoOf, nextBirthday, parseISO, todayISO } from '../lib/household-date.js'

// Household calendar (ahaqqu/RumaQ#430): one shared family month view over the
// union endpoint — stored events (kind: 'event', CRUD on /api/calendar/events)
// and DERIVED document deadlines (kind: 'deadline', read-only — the #426
// expiry metadata surfacing automatically). Core feature, not a plugin: the
// route + nav entry hang off the household group directly (no catalog
// registration, per the ticket).
//
// Indonesian moments (school enrollment, mudik prep, annual tax, birthdays)
// are quick-add TEMPLATES below: buttons that pre-fill the visible create
// form — first-class, not hidden magic rows. The birthday preset resolves a
// member: household_members carries birth_date since 0020 (nullable, often
// unset), so the preset prefills the next occurrence when it exists and falls
// back to a picked date — no member-birthdate migration here (#430 notes the
// interpretation; recurring reminders are a v1 non-goal).

const EVENT_TITLE_MAX = 120

// Error vocabulary mirrors the backend's calendar app: the status picks the
// copy, never the raw server string (the taskErrorKey pattern).
function calendarErrorKey(error) {
  const status = error instanceof ApiError ? error.status : undefined
  if (status === 403) return 'calendar.onlyCreatorOwner'
  return 'calendar.errorGeneric'
}

/** The visible month's cell grid: Monday-start weeks (the household calendar
 * convention), minimal rows, ISO keys. The 5th/6th week spills into the
 * adjacent months — those cells stay inert (no entries fetched for them). */
function monthCells(year, month) {
  const first = new Date(Date.UTC(year, month, 1))
  const offset = (first.getUTCDay() + 6) % 7 // Monday = 0
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const total = offset + daysInMonth
  const rows = Math.ceil(total / 7)
  const cells = []
  for (let i = 0; i < rows * 7; i++) {
    const day = new Date(Date.UTC(year, month, 1 - offset + i))
    cells.push({ iso: isoOf(day), inMonth: day.getUTCMonth() === month })
  }
  return cells
}

/** The month window the endpoint filters on: [first, last] inclusive. */
function monthWindow(year, month) {
  const last = new Date(Date.UTC(year, month + 1, 0))
  return { from: isoOf(new Date(Date.UTC(year, month, 1))), to: isoOf(last) }
}

const PRESETS = ['birthday', 'school', 'mudik', 'tax']

function InlineField({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm min-w-0">
      <span className="text-text-muted">{label}</span>
      {children}
    </label>
  )
}

// The shared field set (title / date / time / visibility / audience) for the
// create panel and the inline edit form. Free-text title — no preset category
// list (the #422/#429 philosophy).
function EventFormFields({ draft, setDraft, members, birthdayMember, onBirthdayMember }) {
  const { t } = useTranslation()
  const showAudience = draft.visibility === 'members'
  return (
    <>
      <InlineField label={t('calendar.titleLabel')}>
        <input
          className="w-full"
          value={draft.title}
          maxLength={EVENT_TITLE_MAX}
          placeholder={t('calendar.titlePlaceholder')}
          aria-label={t('calendar.titleLabel')}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
      </InlineField>
      <InlineField label={t('calendar.dateLabel')}>
        <input
          type="date"
          className="w-full"
          value={draft.date}
          onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
        />
      </InlineField>
      <InlineField label={t('calendar.timeLabel')}>
        <input
          type="time"
          className="w-full"
          value={draft.time ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value || null }))}
        />
      </InlineField>
      <InlineField label={t('calendar.visibilityLabel')}>
        <div
          role="group"
          aria-label={t('calendar.visibilityLabel')}
          className="flex items-center gap-2"
        >
          <Chip
            variant="filter"
            pressed={draft.visibility === 'all'}
            aria-pressed={draft.visibility === 'all'}
            onClick={() => setDraft((d) => ({ ...d, visibility: 'all' }))}
          >
            {t('calendar.visibilityAll')}
          </Chip>
          <Chip
            variant="filter"
            pressed={draft.visibility === 'members'}
            aria-pressed={draft.visibility === 'members'}
            onClick={() => setDraft((d) => ({ ...d, visibility: 'members' }))}
          >
            {t('calendar.visibilityMembers')}
          </Chip>
        </div>
      </InlineField>
      {showAudience && (
        <InlineField label={t('calendar.membersLabel')}>
          <div
            role="group"
            aria-label={t('calendar.membersLabel')}
            className="flex flex-wrap items-center gap-2"
          >
            {members.map((m) => {
              const picked = draft.member_ids.includes(m.id)
              return (
                <Chip
                  key={m.id}
                  variant="filter"
                  pressed={picked}
                  aria-pressed={picked}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      member_ids: picked
                        ? d.member_ids.filter((id) => id !== m.id)
                        : [...d.member_ids, m.id],
                    }))
                  }
                >
                  {m.display_name || m.name || m.email || '?'}
                </Chip>
              )
            })}
          </div>
          <span className="text-xs text-text-muted">{t('calendar.membersHint')}</span>
        </InlineField>
      )}
      {/* The birthday preset's member picker — the title/date prefill reacts
          to the chosen member (birth_date prefill when stored, 0020). */}
      {birthdayMember !== undefined && (
        <InlineField label={t('calendar.birthdayForLabel')}>
          <select
            className="w-full"
            data-testid="birthday-member-select"
            value={birthdayMember}
            onChange={(e) => onBirthdayMember(e.target.value)}
          >
            <option value="">{t('calendar.birthdayPick')}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name || m.name || m.email || '?'}
              </option>
            ))}
          </select>
        </InlineField>
      )}
    </>
  )
}

// One row in the selected-day list: events carry their manage actions
// (creator/owner only, mirroring the backend matrix); deadline rows are
// read-only (they derive from the vault — manage the DOCUMENT, not the view).
function EntryRow({
  entry,
  memberById,
  members,
  canManage,
  editOpen,
  onToggleEdit,
  onDelete,
  onSaveEdit,
  editDraft,
  setEditDraft,
  editPending,
}) {
  const { t } = useTranslation()
  const isDeadline = entry.kind === 'deadline'

  if (isDeadline) {
    const expired = entry.days_until_expiry < 0
    return (
      <div className="px-5 py-4 border-b border-border last:border-b-0" data-testid="deadline-row">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate">{entry.title}</div>
            <div className="text-sm text-text-muted mt-0.5 flex flex-wrap items-center gap-2">
              <Chip variant="accent">
                <IconKey size={12} /> {t('calendar.deadlineChip')}
              </Chip>
              <span
                className={cn('text-sm', expired ? 'text-danger font-medium' : 'text-text-muted')}
              >
                {expired
                  ? t('calendar.expired')
                  : t('calendar.expiresIn', { count: entry.days_until_expiry })}
              </span>
              {entry.due_soon && !expired && (
                <span className="text-warning text-sm">{t('calendar.dueSoon')}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const audience =
    entry.visibility === 'members'
      ? (entry.member_ids ?? [])
          .map(
            (id) =>
              memberById(id)?.display_name || memberById(id)?.name || memberById(id)?.email || '?'
          )
          .join(', ')
      : null

  return (
    <div className="px-5 py-4 border-b border-border last:border-b-0" data-testid="event-row">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{entry.title}</div>
          <div className="text-sm text-text-muted mt-0.5 flex flex-wrap items-center gap-2">
            {entry.time ? (
              <span className="inline-flex items-center gap-1 text-sm text-text-muted">
                <IconClock size={13} />
                {entry.time}
              </span>
            ) : (
              <Chip variant="default">{t('calendar.allDay')}</Chip>
            )}
            {audience !== null && (
              <span
                className="text-sm text-text-muted truncate"
                title={audience || t('calendar.noAudience')}
              >
                {t('calendar.visibleTo', { names: audience || t('calendar.noAudience') })}
              </span>
            )}
          </div>
        </div>
        {canManage(entry) && (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" variant="ghost" onClick={onToggleEdit} aria-expanded={editOpen}>
              {t('calendar.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onDelete}
              aria-label={t('calendar.delete')}
              className="text-danger"
            >
              <IconTrash size={16} />
            </Button>
          </div>
        )}
      </div>
      {editOpen && (
        <div className="mt-3 flex flex-wrap items-end gap-3" data-testid="event-edit-fields">
          <EventFormFields draft={editDraft} setDraft={setEditDraft} members={members} />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={onSaveEdit}
              disabled={editPending || !editDraft.title.trim()}
            >
              {t('calendar.saveEdit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggleEdit}>
              {t('calendar.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function Calendar() {
  const { t, i18n } = useTranslation()
  const { data: me } = useMe()

  const { data: householdsData, isLoading } = useHouseholds()
  const active = householdsData?.households?.find((h) => h.is_active) ?? null
  const isOwner = active?.role === 'owner'
  const { data: membersData } = useHouseholdMembers(active?.id)
  const members = membersData?.members ?? []
  const memberById = (id) => members.find((m) => m.id === id)
  const myMemberId = members.find((m) => m.user_id === me?.user?.id)?.id ?? null

  // The visible month (UTC month arithmetic on the ISO grid — the household
  // day convention); defaulting to today's month.
  const today = todayISO()
  const [view, setView] = useState({
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)) - 1,
  })
  const monthWin = monthWindow(view.year, view.month)
  const { data: calendarData, isLoading: entriesLoading } = useCalendar(monthWin)
  const entries = calendarData?.entries ?? []

  // Selected day (defaults to today when it falls in the visible month,
  // otherwise the 1st).
  const [selected, setSelected] = useState(
    today.slice(0, 7) === `${view.year}-${String(view.month + 1).padStart(2, '0')}`
      ? today
      : `${view.year}-${String(view.month + 1).padStart(2, '0')}-01`
  )

  const createEvent = useCreateCalendarEvent()
  const updateEvent = useUpdateCalendarEvent()
  const deleteEvent = useDeleteCalendarEvent()

  const emptyDraft = { title: '', date: selected, time: null, visibility: 'all', member_ids: [] }
  const [createDraft, setCreateDraft] = useState(emptyDraft)
  const [birthdayMember, setBirthdayMember] = useState(undefined)
  const [presetHint, setPresetHint] = useState(null)
  const [editingEventId, setEditingEventId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const [actionError, setActionError] = useState(null)

  const canManage = (entry) =>
    isOwner || (entry.created_by_member_id !== null && entry.created_by_member_id === myMemberId)

  const cells = useMemo(() => monthCells(view.year, view.month), [view])
  const byDate = useMemo(() => {
    const map = new Map()
    for (const entry of entries) {
      const list = map.get(entry.date)
      if (list) list.push(entry)
      else map.set(entry.date, [entry])
    }
    // The server returns day-ordered entries; keep insertion order per day.
    return map
  }, [entries])

  const dayEntries = byDate.get(selected) ?? []

  const monthLabel = new Intl.DateTimeFormat(i18n.language, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(view.year, view.month, 1)))

  // Weekday headers anchored on a known Monday (2023-01-02) so the seven
  // short names come back in Monday-first order in every locale.
  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' })
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2023, 0, 2 + i))))
  }, [i18n.language])

  const dayNumberFmt = (iso) => parseISO(iso).getUTCDate()

  const shiftMonth = (delta) => {
    const next = new Date(Date.UTC(view.year, view.month + delta, 1))
    const year = next.getUTCFullYear()
    const month = next.getUTCMonth()
    const monthIso = `${year}-${String(month + 1).padStart(2, '0')}`
    // Move the selection into the new month (the 1st; today when it is one).
    setView({ year, month })
    setSelected(today.startsWith(monthIso) ? today : `${monthIso}-01`)
  }

  const goToday = () => {
    const year = Number(today.slice(0, 4))
    const month = Number(today.slice(5, 7)) - 1
    setView({ year, month })
    setSelected(today)
  }

  const applyPreset = (preset) => {
    setActionError(null)
    if (preset === 'birthday') {
      // The birthday preset needs a member — open the picker; the title/date
      // prefill in pickBirthdayMember below.
      setBirthdayMember('')
      setPresetHint('birthday')
      setCreateDraft((d) => ({ ...d, visibility: 'all' }))
      return
    }
    setBirthdayMember(undefined)
    setPresetHint(preset)
    setCreateDraft((d) => ({
      ...d,
      title: t(`calendar.presetContent.${preset}.title`),
      visibility: 'all',
      member_ids: [],
    }))
  }

  const pickBirthdayMember = (memberId) => {
    setBirthdayMember(memberId)
    const member = memberById(memberId)
    if (!member) return
    const name = member.display_name || member.name || member.email || '?'
    const birth = member.birth_date ? nextBirthday(member.birth_date, today) : null
    setCreateDraft((d) => ({
      ...d,
      title: t('calendar.birthdayTitle', { name }),
      date: birth ?? d.date,
    }))
  }

  const submitCreate = () => {
    const title = createDraft.title.trim()
    if (!title || !createDraft.date) return
    createEvent.mutate(
      {
        title,
        date: createDraft.date,
        time: createDraft.time || null,
        visibility: createDraft.visibility,
        member_ids: createDraft.visibility === 'members' ? createDraft.member_ids : undefined,
      },
      {
        onSuccess: () => {
          setCreateDraft({ ...emptyDraft, date: selected })
          setBirthdayMember(undefined)
          setPresetHint(null)
          setActionError(null)
        },
        onError: (err) => setActionError(t(calendarErrorKey(err))),
      }
    )
  }

  const openEdit = (entry) => {
    setEditingEventId(entry.id)
    setEditDraft({
      title: entry.title,
      date: entry.date,
      time: entry.time,
      visibility: entry.visibility,
      member_ids: entry.member_ids ? [...entry.member_ids] : [],
    })
  }

  const saveEdit = () => {
    if (!editDraft) return
    const title = editDraft.title.trim()
    if (!title || !editDraft.date) return
    updateEvent.mutate(
      {
        id: editingEventId,
        payload: {
          title,
          date: editDraft.date,
          time: editDraft.time || null,
          visibility: editDraft.visibility,
          ...(editDraft.visibility === 'members' ? { member_ids: editDraft.member_ids } : {}),
        },
      },
      {
        onSuccess: () => {
          setEditingEventId(null)
          setEditDraft(null)
          setActionError(null)
        },
        onError: (err) => setActionError(t(calendarErrorKey(err))),
      }
    )
  }

  const remove = (entry) => {
    if (!window.confirm(t('calendar.deleteConfirm', { title: entry.title }))) return
    deleteEvent.mutate(
      { id: entry.id },
      { onError: (err) => setActionError(t(calendarErrorKey(err))) }
    )
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <SkeletonRows n={4} />
      </div>
    )
  }

  const renderDayList = () => {
    const label = new Intl.DateTimeFormat(i18n.language, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }).format(parseISO(selected))
    return (
      <Panel data-testid="day-list">
        <PanelHead>
          <div className="font-semibold">{label}</div>
          <Chip variant="loc">{t('calendar.entryCount', { count: dayEntries.length })}</Chip>
        </PanelHead>
        {dayEntries.length === 0 ? (
          <PanelBody>
            <EmptyState
              icon={IconCalendarBlank}
              title={t('calendar.emptyDayTitle')}
              desc={t('calendar.emptyDayDesc')}
            />
          </PanelBody>
        ) : (
          <div>
            {dayEntries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                memberById={memberById}
                members={members}
                canManage={canManage}
                editOpen={editingEventId === entry.id}
                onToggleEdit={() =>
                  editingEventId === entry.id
                    ? (setEditingEventId(null), setEditDraft(null))
                    : openEdit(entry)
                }
                onDelete={() => remove(entry)}
                onSaveEdit={saveEdit}
                editDraft={editDraft}
                setEditDraft={setEditDraft}
                editPending={updateEvent.isPending}
              />
            ))}
          </div>
        )}
      </Panel>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {actionError && (
        <div role="alert" className="px-4 py-3 rounded-lg bg-danger-soft text-sm text-danger">
          {actionError}
        </div>
      )}

      {/* Month navigation + the grid. Each cell lists its entries (2 + a
          count); clicking selects the day for the list below. */}
      <Panel>
        <PanelHead>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => shiftMonth(-1)}
              aria-label={t('calendar.prevMonth')}
            >
              <IconArrowLeft size={16} />
            </Button>
            <div className="font-semibold min-w-[9rem] text-center">{monthLabel}</div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => shiftMonth(1)}
              aria-label={t('calendar.nextMonth')}
            >
              <IconArrowRight size={16} />
            </Button>
          </div>
          <Button size="sm" variant="secondary" onClick={goToday}>
            {t('calendar.today')}
          </Button>
        </PanelHead>
        <PanelBody className="overflow-x-auto">
          {entriesLoading ? (
            <SkeletonRows n={3} />
          ) : (
            <div
              role="grid"
              aria-label={t('calendar.gridLabel')}
              className="grid grid-cols-7 gap-1 min-w-[42rem]"
            >
              {weekdays.map((wd) => (
                <div
                  key={wd}
                  role="columnheader"
                  className="text-xs text-text-muted text-center py-1"
                >
                  {wd}
                </div>
              ))}
              {cells.map((cell) => {
                const cellEntries = cell.inMonth ? (byDate.get(cell.iso) ?? []) : []
                const isSelected = cell.iso === selected
                const isToday = cell.iso === today
                return (
                  <button
                    key={cell.iso}
                    type="button"
                    role="gridcell"
                    aria-selected={isSelected}
                    aria-label={cell.iso}
                    data-testid={`day-${cell.iso}`}
                    onClick={() => cell.inMonth && setSelected(cell.iso)}
                    className={cn(
                      'rounded-lg border p-1.5 min-h-16 text-left transition-colors',
                      !cell.inMonth && 'opacity-40',
                      isSelected
                        ? 'border-accent bg-accent-soft'
                        : 'border-border hover:bg-surface-sunken',
                      isToday && !isSelected && 'border-accent-soft-border'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className={cn('text-sm', isToday && 'font-bold text-accent-hover')}>
                        {dayNumberFmt(cell.iso)}
                      </span>
                      {cellEntries.length > 2 && (
                        <span className="text-[10px] text-text-muted">
                          +{cellEntries.length - 2}
                        </span>
                      )}
                    </div>
                    {cellEntries.slice(0, 2).map((entry) => (
                      <div
                        key={entry.id}
                        className={cn(
                          'flex items-center gap-1 text-[11px] leading-tight truncate mt-0.5',
                          entry.kind === 'deadline' ? 'text-warn' : 'text-accent-hover'
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'w-1.5 h-1.5 rounded-full shrink-0',
                            entry.kind === 'deadline' ? 'bg-warn' : 'bg-accent'
                          )}
                        />
                        <span className="truncate">{entry.title}</span>
                      </div>
                    ))}
                  </button>
                )
              })}
            </div>
          )}
        </PanelBody>
      </Panel>

      {renderDayList()}

      {/* Quick-add presets — the Indonesian moments as first-class templates
          (#430): visible buttons that pre-fill the form below, not hidden
          rows. */}
      <Panel>
        <PanelHead>
          <div className="font-semibold">{t('calendar.presetTitle')}</div>
        </PanelHead>
        <PanelBody className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <Chip
                key={preset}
                variant="filter"
                pressed={false}
                onClick={() => applyPreset(preset)}
              >
                {t(`calendar.preset.${preset}`)}
              </Chip>
            ))}
          </div>
          {presetHint && (
            <p className="text-xs text-text-muted">
              {t(`calendar.presetContent.${presetHint}.hint`)}
            </p>
          )}
        </PanelBody>
      </Panel>

      {/* Create — any linked member creates (profile-only members have no
          account and never act, 0021). */}
      <Panel>
        <PanelHead>
          <div className="font-semibold">{t('calendar.createTitle')}</div>
        </PanelHead>
        <PanelBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <EventFormFields
              draft={createDraft}
              setDraft={setCreateDraft}
              members={members}
              birthdayMember={birthdayMember}
              onBirthdayMember={pickBirthdayMember}
            />
            <Button
              size="sm"
              onClick={submitCreate}
              disabled={createEvent.isPending || !createDraft.title.trim() || !createDraft.date}
            >
              <IconPlus size={15} /> {t('calendar.create')}
            </Button>
          </div>
        </PanelBody>
      </Panel>
    </div>
  )
}
