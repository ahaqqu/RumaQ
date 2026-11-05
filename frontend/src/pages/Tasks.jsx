import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMe } from '../lib/queries/me.js'
import {
  useHouseholds,
  useHouseholdMembers,
  useTasks,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
} from '../lib/queries/index.js'
import { ApiError } from '../lib/api'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { Button } from '../components/Button.jsx'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import {
  IconTask,
  IconPlus,
  IconTrash,
  IconCheck,
  IconCalendarBlank,
  IconRefresh,
} from '../components/icons.jsx'
import { cn } from '../lib/cn.js'

// Household tasks (ahaqqu/RumaQ#429): per-member family task assignments.
// Two views over the same endpoint — the per-member "My tasks" list (mine=1)
// and the household board (open/done columns, assignee chips). The permission
// affordances mirror the backend matrix so buttons never advertise an action
// the server will refuse: manage = creator or household owner; complete =
// assignee-self, creator, or owner (parents complete the profile-only kids'
// chores on their behalf); approve = creator or owner, on done tasks whose
// assignee is a profile-only member.

const TASK_TITLE_MAX = 120

// Error vocabulary mirrors the backend's tasks app: the status picks the
// copy, never the raw server string (the householdErrorKey pattern).
function taskErrorKey(error) {
  const status = error instanceof ApiError ? error.status : undefined
  if (status === 403) return 'tasks.onlyCreatorOwner'
  if (status === 409) return 'tasks.conflict'
  return 'tasks.errorGeneric'
}

function formatDate(value, language) {
  if (!value) return null
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

// The assignee chip — the member-chip component the vault and the roster use:
// display name for profile-only members, account name/email for linked ones.
function AssigneeChip({ member, unassigned }) {
  const { t } = useTranslation()
  if (!member && unassigned) {
    return <Chip variant="loc">{t('tasks.unassigned')}</Chip>
  }
  if (!member) return null
  return (
    <Chip variant={member.has_account === false ? 'accent' : 'loc'}>
      {member.display_name || member.name || member.email || '?'}
    </Chip>
  )
}

function RecurrenceChip({ recurrence }) {
  const { t } = useTranslation()
  if (!recurrence) return null
  return (
    <Chip variant="default">
      <IconRefresh size={12} />
      {t(`tasks.recurrence.${recurrence}`)}
    </Chip>
  )
}

function InlineField({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm min-w-0">
      <span className="text-text-muted">{label}</span>
      {children}
    </label>
  )
}

// One task row: title, assignee chip, due date (overdue highlights), the
// derived-approval affordances, and the manage actions. Editing expands an
// inline form (the MemberRow pattern) — no window.prompt.
function TaskRow({
  task,
  memberById,
  members,
  canManage,
  canComplete,
  canApprove,
  editOpen,
  onToggleEdit,
  onComplete,
  onApprove,
  onDelete,
  onSaveEdit,
  editDraft,
  setEditDraft,
  editPending,
  language,
}) {
  const { t } = useTranslation()
  const taskMembers = members ?? []
  const overdue = task.status === 'open' && task.due_date && task.due_date < todayISO()
  const dueLabel = formatDate(task.due_date, language)
  return (
    <div className="px-5 py-4 border-b border-border last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'font-medium truncate',
              task.status === 'done' && 'text-text-muted line-through'
            )}
          >
            {task.title}
          </div>
          <div className="text-sm text-text-muted mt-0.5 flex flex-wrap items-center gap-2">
            <AssigneeChip
              member={task.assignee_member_id ? memberById(task.assignee_member_id) : null}
              unassigned
            />
            {task.due_date && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-sm',
                  overdue ? 'text-danger font-medium' : 'text-text-muted'
                )}
              >
                <IconCalendarBlank size={13} />
                {t('tasks.due', { date: dueLabel ?? task.due_date })}
              </span>
            )}
            <RecurrenceChip recurrence={task.recurrence} />
            {task.status === 'done' && task.needs_approval && !task.approved_by_member_id && (
              <Chip variant="accent">{t('tasks.awaitingApproval')}</Chip>
            )}
            {task.approved_by_member_id && (
              <span className="inline-flex items-center gap-1 text-ok">
                <IconCheck size={13} /> {t('tasks.approved')}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {canComplete(task) && task.status === 'open' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onComplete(task)}
              disabled={editPending}
            >
              <IconCheck size={15} /> {t('tasks.complete')}
            </Button>
          )}
          {canApprove(task) && (
            <Button size="sm" onClick={() => onApprove(task)} disabled={editPending}>
              {t('tasks.approve')}
            </Button>
          )}
          {canManage(task) && (
            <>
              <Button size="sm" variant="ghost" onClick={onToggleEdit} aria-expanded={editOpen}>
                {t('tasks.edit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDelete(task)}
                aria-label={t('tasks.delete')}
                className="text-danger"
              >
                <IconTrash size={16} />
              </Button>
            </>
          )}
        </div>
      </div>
      {editOpen && (
        <div className="mt-3 flex flex-wrap items-end gap-3" data-testid="task-edit-fields">
          <TaskFormFields draft={editDraft} setDraft={setEditDraft} members={taskMembers} />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={onSaveEdit}
              disabled={editPending || !editDraft.title.trim()}
            >
              {t('tasks.saveEdit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggleEdit}>
              {t('tasks.cancel')}
            </Button>
          </div>
        </div>
      )}
      {!editOpen && task.recurrence && task.status === 'open' && (
        <div className="mt-2 text-xs text-text-muted">{t('tasks.recurringHint')}</div>
      )}
    </div>
  )
}

// The shared field triplet (title / assignee / due + recurrence) for the
// create panel and the inline edit form. Free-text title — no preset
// category list (#429, the #422 document-name philosophy).
function TaskFormFields({ draft, setDraft, members }) {
  const { t } = useTranslation()
  return (
    <>
      <InlineField label={t('tasks.titleLabel')}>
        <input
          className="w-full"
          value={draft.title}
          maxLength={TASK_TITLE_MAX}
          placeholder={t('tasks.titlePlaceholder')}
          aria-label={t('tasks.titleLabel')}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
      </InlineField>
      <InlineField label={t('tasks.assigneeLabel')}>
        <select
          className="w-full"
          data-testid="task-assignee-select"
          value={draft.assignee_member_id}
          onChange={(e) => setDraft((d) => ({ ...d, assignee_member_id: e.target.value }))}
        >
          <option value="">{t('tasks.assigneeNone')}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name || m.name || m.email || '?'}
            </option>
          ))}
        </select>
      </InlineField>
      <InlineField label={t('tasks.dueDateLabel')}>
        <input
          type="date"
          className="w-full"
          value={draft.due_date}
          onChange={(e) => setDraft((d) => ({ ...d, due_date: e.target.value }))}
        />
      </InlineField>
      <InlineField label={t('tasks.recurrenceLabel')}>
        <select
          className="w-full"
          value={draft.recurrence}
          onChange={(e) => setDraft((d) => ({ ...d, recurrence: e.target.value }))}
        >
          <option value="">{t('tasks.recurrenceNone')}</option>
          <option value="daily">{t('tasks.recurrence.daily')}</option>
          <option value="weekly">{t('tasks.recurrence.weekly')}</option>
          <option value="monthly">{t('tasks.recurrence.monthly')}</option>
        </select>
      </InlineField>
    </>
  )
}

export function Tasks() {
  const { t, i18n } = useTranslation()
  const { data: me } = useMe()

  const { data: householdsData, isLoading } = useHouseholds()
  const active = householdsData?.households?.find((h) => h.is_active) ?? null
  const isOwner = active?.role === 'owner'
  const { data: membersData } = useHouseholdMembers(active?.id)
  const members = membersData?.members ?? []
  const memberById = (id) => members.find((m) => m.id === id)
  // The caller's own member row — 'me', creator checks, and assignee-self all
  // key on the surrogate member id (0021), not the user id.
  const myMemberId = members.find((m) => m.user_id === me?.user?.id)?.id ?? null

  // View toggle: the per-member "My tasks" list or the household board. Both
  // read the same endpoint; the filter rides the query key.
  const [view, setView] = useState('board')
  const { data: tasksData, isLoading: tasksLoading } = useTasks(
    view === 'mine' ? { mine: '1', status: 'all' } : {}
  )
  const tasks = tasksData?.tasks ?? []
  const openTasks = tasks.filter((task) => task.status === 'open')
  const doneTasks = tasks.filter((task) => task.status === 'done')

  const createTask = useCreateTask()
  const updateTask = useUpdateTask()
  const deleteTask = useDeleteTask()

  const [createDraft, setCreateDraft] = useState({
    title: '',
    assignee_member_id: '',
    due_date: '',
    recurrence: '',
  })
  const [editingTaskId, setEditingTaskId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const [actionError, setActionError] = useState(null)

  const canManage = (task) =>
    isOwner || (task.created_by_member_id !== null && task.created_by_member_id === myMemberId)
  const canComplete = (task) =>
    isOwner ||
    (task.created_by_member_id !== null && task.created_by_member_id === myMemberId) ||
    task.assignee_member_id === myMemberId
  const canApprove = (task) =>
    task.status === 'done' && task.needs_approval && !task.approved_by_member_id && canManage(task)

  const submitCreate = () => {
    const title = createDraft.title.trim()
    if (!title) return
    createTask.mutate(
      {
        title,
        assignee_member_id: createDraft.assignee_member_id || null,
        due_date: createDraft.due_date || null,
        recurrence: createDraft.recurrence || null,
      },
      {
        onSuccess: () => {
          setCreateDraft({ title: '', assignee_member_id: '', due_date: '', recurrence: '' })
          setActionError(null)
        },
        onError: (err) => setActionError(t(taskErrorKey(err))),
      }
    )
  }

  const openEdit = (task) => {
    setEditingTaskId(task.id)
    setEditDraft({
      title: task.title,
      assignee_member_id: task.assignee_member_id ?? '',
      due_date: task.due_date ?? '',
      recurrence: task.recurrence ?? '',
    })
  }

  const saveEdit = () => {
    if (!editDraft) return
    const title = editDraft.title.trim()
    if (!title) return
    updateTask.mutate(
      {
        id: editingTaskId,
        payload: {
          title,
          assignee_member_id: editDraft.assignee_member_id || null,
          due_date: editDraft.due_date || null,
          recurrence: editDraft.recurrence || null,
        },
      },
      {
        onSuccess: () => {
          setEditingTaskId(null)
          setEditDraft(null)
          setActionError(null)
        },
        onError: (err) => setActionError(t(taskErrorKey(err))),
      }
    )
  }

  const complete = (task) => {
    updateTask.mutate(
      { id: task.id, payload: { status: 'done' } },
      { onError: (err) => setActionError(t(taskErrorKey(err))) }
    )
  }

  const approve = (task) => {
    updateTask.mutate(
      { id: task.id, payload: { approve: true } },
      { onError: (err) => setActionError(t(taskErrorKey(err))) }
    )
  }

  const remove = (task) => {
    if (!window.confirm(t('tasks.deleteConfirm', { title: task.title }))) return
    deleteTask.mutate({ id: task.id }, { onError: (err) => setActionError(t(taskErrorKey(err))) })
  }

  const editDraftWithMembers = editDraft

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <SkeletonRows n={4} />
      </div>
    )
  }

  const renderTaskList = (list) =>
    list.length === 0 ? (
      <PanelBody>
        <EmptyState icon={IconTask} title={t('tasks.emptyTitle')} desc={t('tasks.emptyDesc')} />
      </PanelBody>
    ) : (
      <div>
        {list.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            memberById={memberById}
            members={members}
            canManage={canManage}
            canComplete={canComplete}
            canApprove={canApprove}
            editOpen={editingTaskId === task.id}
            onToggleEdit={() =>
              editingTaskId === task.id ? setEditingTaskId(null) : openEdit(task)
            }
            onComplete={complete}
            onApprove={approve}
            onDelete={remove}
            onSaveEdit={saveEdit}
            editDraft={editDraftWithMembers}
            setEditDraft={setEditDraft}
            editPending={updateTask.isPending}
            language={i18n.language}
          />
        ))}
      </div>
    )

  return (
    <div className="flex flex-col gap-6">
      {actionError && (
        <div role="alert" className="px-4 py-3 rounded-lg bg-danger-soft text-sm text-danger">
          {actionError}
        </div>
      )}

      {/* View toggle — the same pressed-chip segmented control as the
          household Add-person modes. */}
      <div role="group" aria-label={t('tasks.viewToggle')} className="flex items-center gap-2">
        <Chip
          variant="filter"
          pressed={view === 'mine'}
          aria-pressed={view === 'mine'}
          onClick={() => setView('mine')}
        >
          {t('tasks.viewMine')}
        </Chip>
        <Chip
          variant="filter"
          pressed={view === 'board'}
          aria-pressed={view === 'board'}
          onClick={() => setView('board')}
        >
          {t('tasks.viewBoard')}
        </Chip>
      </div>

      {/* Create — any linked member creates (profile-only members have no
          account and never act; needs_approval derives server-side from the
          assignee's mode). */}
      <Panel>
        <PanelHead>
          <div className="font-semibold">{t('tasks.createTitle')}</div>
        </PanelHead>
        <PanelBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <TaskFormFields draft={createDraft} setDraft={setCreateDraft} members={members} />
            <Button
              size="sm"
              onClick={submitCreate}
              disabled={createTask.isPending || !createDraft.title.trim()}
            >
              <IconPlus size={15} /> {t('tasks.create')}
            </Button>
          </div>
        </PanelBody>
      </Panel>

      {tasksLoading ? (
        <Panel>
          <PanelBody aria-busy="true">
            <SkeletonRows n={3} />
          </PanelBody>
        </Panel>
      ) : view === 'mine' ? (
        <Panel>
          <PanelHead>
            <div>
              <div className="font-semibold">{t('tasks.viewMine')}</div>
              <div className="text-sm text-text-muted mt-0.5">{t('tasks.mineSubtitle')}</div>
            </div>
            <Chip variant="loc">{t('tasks.openCount', { count: openTasks.length })}</Chip>
          </PanelHead>
          {renderTaskList(tasks)}
        </Panel>
      ) : (
        /* The household board — kanban-lite: open (due date first, the
           server's order) and done columns. */
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHead>
              <div className="font-semibold">{t('tasks.openTitle')}</div>
              <Chip variant="loc">{t('tasks.openCount', { count: openTasks.length })}</Chip>
            </PanelHead>
            {renderTaskList(openTasks)}
          </Panel>
          <Panel>
            <PanelHead>
              <div className="font-semibold">{t('tasks.doneTitle')}</div>
              <Chip variant="loc">{t('tasks.doneCount', { count: doneTasks.length })}</Chip>
            </PanelHead>
            {renderTaskList(doneTasks)}
          </Panel>
        </div>
      )}
    </div>
  )
}
