import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useHouseholds,
  useHouseholdMembers,
  useDocuments,
  useUploadDocument,
  useDeleteDocument,
} from '../lib/queries/index.js'
import { ApiError, DOCUMENT_CATEGORIES, DOCUMENT_MAX_BYTES, fetchDocumentContent } from '../lib/api'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { Button } from '../components/Button.jsx'
import { EmptyState, SkeletonRows } from '../components/ui.jsx'
import {
  IconFolderLock,
  IconUpload,
  IconTrash,
  IconDownload,
  IconClose,
  IconCheck,
  IconEye,
} from '../components/icons.jsx'

// Error vocabulary mirrors the backend's documents app: the status picks the
// copy, never the raw server string. A 415 means the bytes did not agree with
// the declared type (sniff policy: reject); a 413 the 10 MB cap.
function documentErrorKey(error) {
  const status = error instanceof ApiError ? error.status : undefined
  if (status === 413) return 'documents.errorTooLarge'
  if (status === 415) return 'documents.errorType'
  return 'documents.errorGeneric'
}

function formatBytes(bytes, language) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value)} ${unit}`
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

// One filter-chip group (Household.jsx pattern): a labelled group of
// pressed-state chips, no tab semantics.
function ChipGroup({ label, children }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {children}
    </div>
  )
}

function CategoryChip({ category, pressed, onSelect }) {
  const { t } = useTranslation()
  return (
    <Chip
      variant="filter"
      pressed={pressed}
      aria-pressed={pressed}
      onClick={() => onSelect(pressed ? null : category)}
    >
      {t(`documents.category.${category}`)}
    </Chip>
  )
}

function MemberChip({ member, pressed, onSelect }) {
  const { t } = useTranslation()
  const name = member.display_name || member.name || member.email
  return (
    <Chip
      variant="filter"
      pressed={pressed}
      aria-pressed={pressed}
      onClick={() => onSelect(pressed ? null : member.id)}
    >
      {name}
      {member.has_account === false && (
        <span className="text-text-muted">· {t('documents.noAccountShort')}</span>
      )}
    </Chip>
  )
}

// In-app viewer: the blob URL is fetched with the session cookie (inline
// disposition — audited as a view server-side), previewed in-app, and always
// revoked on close/unmount. Images render inline; PDF via the object embed.
function DocumentViewer({ document: doc, onClose }) {
  const { t } = useTranslation()
  const [objectUrl, setObjectUrl] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let url = null
    let cancelled = false
    fetchDocumentContent(doc.id, 'inline')
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setObjectUrl(url)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [doc.id])

  const isImage = doc.mime_type.startsWith('image/')

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={doc.file_name}
    >
      <div className="flex items-center justify-between gap-3 pb-3 text-white">
        <div className="min-w-0 truncate text-sm font-medium">{doc.file_name}</div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={t('documents.closeViewer')}>
          <IconClose size={16} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl bg-surface p-2">
        {error ? (
          <p className="text-sm text-danger">{t('documents.viewerError')}</p>
        ) : !objectUrl ? (
          <p className="text-sm text-text-muted">{t('documents.viewerLoading')}</p>
        ) : isImage ? (
          <img
            src={objectUrl}
            alt={doc.file_name}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        ) : doc.mime_type === 'application/pdf' ? (
          <embed src={objectUrl} type="application/pdf" className="h-full w-full rounded-lg" />
        ) : (
          <p className="text-sm text-text-muted">{t('documents.viewerUnsupported')}</p>
        )}
      </div>
    </div>
  )
}

function DocumentRow({
  doc,
  memberName,
  onView,
  onDownload,
  onDelete,
  confirmOpen,
  onToggleConfirm,
  busy,
}) {
  const { t, i18n } = useTranslation()
  return (
    <div className="px-5 py-4 border-b border-border last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl grid place-items-center bg-surface-inset text-text-muted shrink-0">
          <IconFolderLock size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{doc.file_name}</div>
          <div className="text-sm text-text-muted truncate">
            {t(`documents.category.${doc.category}`)}
            {memberName && <> · {memberName}</>} · {formatBytes(doc.size_bytes, i18n.language)}
            {doc.created_at && <> · {formatDate(doc.created_at, i18n.language)}</>}
          </div>
        </div>
        {confirmOpen ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-sm text-text-muted hidden sm:inline">
              {t('documents.deleteConfirm')}
            </span>
            <Button
              size="sm"
              variant="danger"
              onClick={onDelete}
              disabled={busy}
              aria-label={t('documents.deleteConfirmYes')}
            >
              {t('documents.deleteConfirmYes')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggleConfirm} disabled={busy}>
              {t('common.cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" variant="ghost" onClick={onView} aria-label={t('documents.view')}>
              <IconEye size={16} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onDownload}
              aria-label={t('documents.download')}
            >
              <IconDownload size={16} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggleConfirm}
              aria-label={t('documents.delete')}
              className="text-danger"
            >
              <IconTrash size={16} />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

export function Documents() {
  const { t, i18n } = useTranslation()
  const fileInputRef = useRef(null)

  const { data: householdsData, isLoading: householdsLoading } = useHouseholds()
  const households = householdsData?.households ?? []
  const active = households.find((h) => h.is_active) ?? null
  const activeId = active?.id

  const { data: membersData } = useHouseholdMembers(activeId)
  const members = membersData?.members ?? []
  const memberNameById = useMemo(() => {
    const map = new Map()
    for (const member of members) {
      map.set(member.id, member.display_name || member.name || member.email)
    }
    return map
  }, [members])

  // Filter chips: null = unfiltered.
  const [categoryFilter, setCategoryFilter] = useState(null)
  const [memberFilter, setMemberFilter] = useState(null)
  const filters = useMemo(
    () => ({ category: categoryFilter ?? undefined, memberId: memberFilter ?? undefined }),
    [categoryFilter, memberFilter]
  )
  const { data: documentsData, isLoading: documentsLoading } = useDocuments(activeId ? filters : {})
  const documents = (documentsData?.documents ?? []).filter((d) => d.household_id === activeId)

  const upload = useUploadDocument()
  const remove = useDeleteDocument()

  // Upload draft state — its own form, like the Household add form.
  const [uploadCategory, setUploadCategory] = useState(null)
  const [uploadMemberId, setUploadMemberId] = useState('')
  const [pickedFile, setPickedFile] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [confirmingId, setConfirmingId] = useState(null)
  const [viewing, setViewing] = useState(null)

  const pickFile = (event) => {
    const file = event.target.files?.[0] ?? null
    setPickedFile(file)
    // Allow re-picking the same file later.
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const startUpload = () => {
    setFeedback(null)
    setActionError(null)
    if (!pickedFile) {
      setActionError(t('documents.errorNoFile'))
      return
    }
    if (!uploadCategory) {
      setActionError(t('documents.errorNoCategory'))
      return
    }
    // Client-side pre-check: fail before the bytes leave the device.
    if (pickedFile.size > DOCUMENT_MAX_BYTES) {
      setActionError(t('documents.errorTooLarge'))
      return
    }
    upload.mutate(
      { file: pickedFile, category: uploadCategory, memberId: uploadMemberId || undefined },
      {
        onSuccess: (data) => {
          setPickedFile(null)
          setActionError(null)
          setFeedback(
            t('documents.uploaded', { name: data?.document?.file_name ?? pickedFile.name })
          )
        },
        onError: (err) => setActionError(t(documentErrorKey(err))),
      }
    )
  }

  const openViewer = (doc) => {
    setFeedback(null)
    setActionError(null)
    setViewing(doc)
  }

  const download = async (doc) => {
    setFeedback(null)
    setActionError(null)
    try {
      const blob = await fetchDocumentContent(doc.id, 'attachment')
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = doc.file_name
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setActionError(t(documentErrorKey(err)))
    }
  }

  const confirmDelete = (doc) => {
    remove.mutate(
      { id: doc.id },
      {
        onSuccess: () => {
          setConfirmingId(null)
          setActionError(null)
          setFeedback(t('documents.deleted', { name: doc.file_name }))
        },
        onError: (err) => {
          setConfirmingId(null)
          setActionError(t(documentErrorKey(err)))
        },
      }
    )
  }

  if (householdsLoading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <SkeletonRows n={4} />
      </div>
    )
  }

  const documentCount = documents.length

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

      {/* Identity card — the vault is the active household's, same substrate
          as the Household screen's identity card. */}
      <Panel className="p-5">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl grid place-items-center bg-accent-soft text-accent-hover shrink-0">
            <IconFolderLock size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-text truncate">{t('documents.title')}</h2>
            <div className="text-sm text-text-muted">
              {t('documents.subtitle')}
              {active && (
                <Chip variant="default" className="ml-2">
                  {active.name}
                </Chip>
              )}
            </div>
          </div>
          <Chip variant="loc">{t('documents.count', { count: documentCount })}</Chip>
        </div>
      </Panel>

      {/* Upload — file picker, category chips, member select (both modes). */}
      <Panel>
        <PanelHead>
          <div>
            <div className="font-semibold">{t('documents.uploadTitle')}</div>
            <div className="text-sm text-text-muted mt-0.5">{t('documents.uploadHint')}</div>
          </div>
        </PanelHead>
        <PanelBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={pickFile}
              aria-label={t('documents.pickFile')}
            />
            <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
              <IconUpload size={15} />{' '}
              {pickedFile ? t('documents.changeFile') : t('documents.pickFile')}
            </Button>
            {pickedFile && (
              <span
                className="text-sm text-text-muted truncate max-w-[220px]"
                data-testid="picked-file"
              >
                {pickedFile.name} · {formatBytes(pickedFile.size, i18n.language)}
              </span>
            )}
          </div>
          <ChipGroup label={t('documents.categoryLabel')}>
            {DOCUMENT_CATEGORIES.map((category) => (
              <CategoryChip
                key={category}
                category={category}
                pressed={uploadCategory === category}
                onSelect={(value) => setUploadCategory(value)}
              />
            ))}
          </ChipGroup>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm min-w-0">
              <span className="text-text-muted">{t('documents.memberLabel')}</span>
              <select
                className="w-full"
                value={uploadMemberId}
                onChange={(e) => setUploadMemberId(e.target.value)}
              >
                <option value="">{t('documents.memberNone')}</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {(member.display_name || member.name || member.email || '?') +
                      (member.has_account === false ? ` (${t('documents.noAccountShort')})` : '')}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" onClick={startUpload} disabled={upload.isPending || !pickedFile}>
              <IconUpload size={15} /> {t('documents.uploadAction')}
            </Button>
          </div>
        </PanelBody>
      </Panel>

      {/* Filters — category + member chips over the household's vault. */}
      <Panel>
        <PanelHead>
          <div>
            <div className="font-semibold">{t('documents.listTitle')}</div>
            <div className="text-sm text-text-muted mt-0.5">{t('documents.listHint')}</div>
          </div>
        </PanelHead>
        <PanelBody className="flex flex-col gap-3">
          <ChipGroup label={t('documents.filterCategory')}>
            {DOCUMENT_CATEGORIES.map((category) => (
              <CategoryChip
                key={category}
                category={category}
                pressed={categoryFilter === category}
                onSelect={setCategoryFilter}
              />
            ))}
          </ChipGroup>
          {members.length > 0 && (
            <ChipGroup label={t('documents.filterMember')}>
              {members.map((member) => (
                <MemberChip
                  key={member.id}
                  member={member}
                  pressed={memberFilter === member.id}
                  onSelect={setMemberFilter}
                />
              ))}
            </ChipGroup>
          )}
        </PanelBody>
        {documentsLoading ? (
          <PanelBody>
            <SkeletonRows n={3} />
          </PanelBody>
        ) : documents.length === 0 ? (
          <PanelBody>
            <EmptyState
              icon={IconFolderLock}
              title={t('documents.emptyTitle')}
              desc={t('documents.emptyDesc')}
            />
          </PanelBody>
        ) : (
          <div>
            {documents.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                memberName={doc.member_id ? (memberNameById.get(doc.member_id) ?? null) : null}
                onView={() => openViewer(doc)}
                onDownload={() => download(doc)}
                onDelete={() => confirmDelete(doc)}
                confirmOpen={confirmingId === doc.id}
                onToggleConfirm={() => setConfirmingId(confirmingId === doc.id ? null : doc.id)}
                busy={remove.isPending}
              />
            ))}
          </div>
        )}
      </Panel>

      {viewing && <DocumentViewer document={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
