import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useHouseholds,
  useHouseholdMembers,
  useDocuments,
  useCreateDocument,
  useAddDocumentFile,
  useDeleteDocument,
  useDeleteDocumentFile,
} from '../lib/queries/index.js'
import {
  ApiError,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_FILES,
  DOCUMENT_NAME_MAX,
  fetchDocumentContent,
} from '../lib/api'
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
// the declared type (sniff policy: reject); a 413 the 10 MB cap; a 409 the
// document already holds its 20 files (#422).
function documentErrorKey(error) {
  const status = error instanceof ApiError ? error.status : undefined
  if (status === 413) return 'documents.errorTooLarge'
  if (status === 415) return 'documents.errorType'
  if (status === 409) return 'documents.errorTooManyFiles'
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

// A picked-files list shared by the create flow and the add-files flow: each
// picked file shows its name + size and an OPTIONAL free-text label (#422
// owner decision 1 — unnamed files are fine).
function PickedFiles({ picked, onLabel, onRemove, language }) {
  const { t } = useTranslation()
  if (picked.length === 0) return null
  return (
    <ul className="flex flex-col gap-2" data-testid="picked-files">
      {picked.map((entry, index) => (
        <li key={`${entry.file.name}-${index}`} className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-muted truncate max-w-[220px]" data-testid="picked-file">
            {entry.file.name} · {formatBytes(entry.file.size, language)}
          </span>
          <input
            className="flex-1 min-w-[160px] max-w-[280px] text-sm"
            value={entry.label}
            maxLength={DOCUMENT_NAME_MAX}
            onChange={(e) => onLabel(index, e.target.value)}
            placeholder={t('documents.labelPlaceholder')}
            aria-label={`${t('documents.labelAria')}: ${entry.file.name}`}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRemove(index)}
            aria-label={`${t('documents.removePicked')}: ${entry.file.name}`}
            className="text-danger"
          >
            <IconClose size={14} />
          </Button>
        </li>
      ))}
    </ul>
  )
}

// In-app viewer: the blob URL is fetched with the session cookie (inline
// disposition — audited as a view server-side), previewed in-app, and always
// revoked on close/unmount. Images render inline; PDF via the object embed.
// Per file since #422 — the content endpoint is /documents/:id/files/:fileId.
function DocumentViewer({ documentId, file, onClose }) {
  const { t } = useTranslation()
  const [objectUrl, setObjectUrl] = useState(null)
  const [error, setError] = useState(false)
  const dialogRef = useRef(null)
  // The close callback is read from a ref so the focus contract below mounts
  // exactly once (the parent passes an inline handler that changes identity
  // on every render).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Modal-dialog focus contract (the AppShell drawer pattern): focus enters
  // the panel when it opens, Tab stays inside it while the overlay occludes
  // the page, Escape closes, and unmounting hands focus back to whatever
  // opened it.
  useEffect(() => {
    const panel = dialogRef.current
    const previouslyFocused = document.activeElement
    panel?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const focusables = panel.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const inside = active !== panel && panel.contains(active)
      if (!inside) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (previouslyFocused instanceof HTMLElement && previouslyFocused !== document.body) {
        previouslyFocused.focus()
      }
    }
  }, [])

  useEffect(() => {
    let url = null
    let cancelled = false
    fetchDocumentContent(documentId, file.id, 'inline')
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
  }, [documentId, file.id])

  const isImage = file.content_type.startsWith('image/')

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4 outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={file.file_name}
    >
      <div className="flex items-center justify-between gap-3 pb-3 text-white">
        <div className="min-w-0 truncate text-sm font-medium">
          {file.label ? `${file.label} · ` : ''}
          {file.file_name}
        </div>
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
            alt={file.label || file.file_name}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        ) : file.content_type === 'application/pdf' ? (
          <embed src={objectUrl} type="application/pdf" className="h-full w-full rounded-lg" />
        ) : (
          <p className="text-sm text-text-muted">{t('documents.viewerUnsupported')}</p>
        )}
      </div>
    </div>
  )
}

// One file inside its document: name, optional label, size, and the per-file
// actions (view / download / delete — the delete is the same two-step inline
// confirm the document row uses).
function FileRow({ file, onView, onDownload, onDelete, confirmOpen, onToggleConfirm, busy, language }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 pl-11 py-1.5">
      <div className="min-w-0 flex-1">
        <span className="text-sm truncate">
          {file.file_name}
          {file.label && <span className="text-text-muted"> · {file.label}</span>}
        </span>
        <span className="text-sm text-text-muted ml-2 shrink-0">
          {formatBytes(file.size_bytes, language)}
        </span>
      </div>
      {confirmOpen ? (
        <div className="flex items-center gap-1.5 shrink-0">
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
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={onView}
            aria-label={`${t('documents.view')}: ${file.file_name}`}
          >
            <IconEye size={15} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDownload}
            aria-label={`${t('documents.download')}: ${file.file_name}`}
          >
            <IconDownload size={15} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onToggleConfirm}
            aria-label={`${t('documents.deleteFile')}: ${file.file_name}`}
            className="text-danger"
          >
            <IconTrash size={15} />
          </Button>
        </div>
      )}
    </div>
  )
}

function DocumentRow({
  doc,
  memberName,
  onAddFiles,
  onViewFile,
  onDownloadFile,
  onDeleteFile,
  onDeleteDoc,
  fileConfirmKey,
  onToggleFileConfirm,
  docConfirmOpen,
  onToggleDocConfirm,
  removeDocPending,
  removeFilePending,
  language,
}) {
  const { t } = useTranslation()
  return (
    <div className="px-5 py-4 border-b border-border last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl grid place-items-center bg-surface-inset text-text-muted shrink-0">
          <IconFolderLock size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{doc.name}</div>
          <div className="text-sm text-text-muted truncate">
            {t('documents.filesCount', { count: doc.files.length })}
            {memberName && <> · {memberName}</>}
            {doc.created_at && <> · {formatDate(doc.created_at, language)}</>}
          </div>
        </div>
        {docConfirmOpen ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-sm text-text-muted hidden sm:inline">
              {t('documents.deleteConfirm')}
            </span>
            <Button
              size="sm"
              variant="danger"
              onClick={onDeleteDoc}
              disabled={removeDocPending}
              aria-label={t('documents.deleteConfirmYes')}
            >
              {t('documents.deleteConfirmYes')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggleDocConfirm} disabled={removeDocPending}>
              {t('common.cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" variant="ghost" onClick={onAddFiles} disabled={doc.files.length >= DOCUMENT_MAX_FILES}>
              <IconUpload size={15} /> <span className="hidden sm:inline">{t('documents.addFiles')}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggleDocConfirm}
              aria-label={`${t('documents.delete')}: ${doc.name}`}
              className="text-danger"
            >
              <IconTrash size={16} />
            </Button>
          </div>
        )}
      </div>
      {doc.files.length > 0 && (
        <div className="mt-2 flex flex-col divide-y divide-border/60">
          {doc.files.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              language={language}
              onView={() => onViewFile(doc, file)}
              onDownload={() => onDownloadFile(doc, file)}
              onDelete={() => onDeleteFile(doc, file)}
              confirmOpen={fileConfirmKey === `${doc.id}:${file.id}`}
              onToggleConfirm={() => onToggleFileConfirm(`${doc.id}:${file.id}`)}
              busy={removeFilePending}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function Documents() {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const createInputRef = useRef(null)
  const addInputRef = useRef(null)

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

  // Filters: the NAME SEARCH (#422 — the category dropdown is gone) plus the
  // member chips; null = unfiltered.
  const [search, setSearch] = useState('')
  const [memberFilter, setMemberFilter] = useState(null)
  const filters = useMemo(
    () => ({ q: search.trim() || undefined, memberId: memberFilter ?? undefined }),
    [search, memberFilter]
  )
  const { data: documentsData, isLoading: documentsLoading } = useDocuments(
    activeId ? filters : {}
  )
  const documents = (documentsData?.documents ?? []).filter((d) => d.household_id === activeId)

  const create = useCreateDocument()
  const addFile = useAddDocumentFile()
  const remove = useDeleteDocument()
  const removeFile = useDeleteDocumentFile()

  // Create draft state — its own form, like the Household add form. picked
  // files carry an optional per-file label; the create call takes the FIRST
  // file, the rest ride add-file in order (upload order is the pick order).
  const [uploadName, setUploadName] = useState('')
  const [uploadMemberId, setUploadMemberId] = useState('')
  const [pickedFiles, setPickedFiles] = useState([])
  const [addingFor, setAddingFor] = useState(null)
  const [addPicked, setAddPicked] = useState([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [confirmingDocId, setConfirmingDocId] = useState(null)
  const [fileConfirmKey, setFileConfirmKey] = useState(null)
  const [viewing, setViewing] = useState(null)

  const pickCreateFiles = (event) => {
    const files = [...(event.target.files ?? [])]
    if (files.length > 0) {
      setPickedFiles((prev) => [...prev, ...files.map((file) => ({ file, label: '' }))])
    }
    // Allow re-picking the same file later.
    if (createInputRef.current) createInputRef.current.value = ''
  }

  const pickAddFiles = (event) => {
    const files = [...(event.target.files ?? [])]
    if (files.length > 0) {
      setAddPicked((prev) => [...prev, ...files.map((file) => ({ file, label: '' }))])
    }
    if (addInputRef.current) addInputRef.current.value = ''
  }

  const setPickedLabel = (setter) => (index, label) => {
    setter((prev) => prev.map((entry, i) => (i === index ? { ...entry, label } : entry)))
  }

  const removePicked = (setter) => (index) => {
    setter((prev) => prev.filter((_, i) => i !== index))
  }

  const oversizePicked = (list) => list.find((entry) => entry.file.size > DOCUMENT_MAX_BYTES)

  // Create → then the remaining files ride add-file one by one. Sequential,
  // not parallel: the backend orders by max(sort_order) + 1, so parallel
  // calls could race the order; awaiting each keeps pick order = upload
  // order, and the progress line reflects exactly where a failure stopped.
  const startUpload = async () => {
    setFeedback(null)
    setActionError(null)
    const name = uploadName.trim()
    if (!name) {
      setActionError(t('documents.errorNoName'))
      return
    }
    if (pickedFiles.length === 0) {
      setActionError(t('documents.errorNoFile'))
      return
    }
    if (pickedFiles.length > DOCUMENT_MAX_FILES) {
      setActionError(t('documents.errorTooManyFiles'))
      return
    }
    const oversize = oversizePicked(pickedFiles)
    if (oversize) {
      setActionError(t('documents.errorTooLarge'))
      return
    }
    setBusy(true)
    try {
      const first = pickedFiles[0]
      const created = await create.mutateAsync({
        name,
        file: first.file,
        label: first.label || undefined,
        memberId: uploadMemberId || undefined,
      })
      const documentId = created?.document?.id
      const total = pickedFiles.length
      for (let i = 1; i < total; i++) {
        setProgress({ current: i + 1, total })
        const entry = pickedFiles[i]
        await addFile.mutateAsync({
          documentId,
          file: entry.file,
          label: entry.label || undefined,
        })
      }
      setPickedFiles([])
      setUploadName('')
      setActionError(null)
      setFeedback(t('documents.uploaded', { name }))
    } catch (err) {
      setActionError(t(documentErrorKey(err)))
    } finally {
      setProgress(null)
      setBusy(false)
    }
  }

  const startAddFiles = async (doc) => {
    setFeedback(null)
    setActionError(null)
    if (addPicked.length === 0) {
      setActionError(t('documents.errorNoFile'))
      return
    }
    if (doc.files.length + addPicked.length > DOCUMENT_MAX_FILES) {
      setActionError(t('documents.errorTooManyFiles'))
      return
    }
    const oversize = oversizePicked(addPicked)
    if (oversize) {
      setActionError(t('documents.errorTooLarge'))
      return
    }
    setBusy(true)
    try {
      const total = addPicked.length
      for (let i = 0; i < total; i++) {
        setProgress({ current: i + 1, total })
        const entry = addPicked[i]
        await addFile.mutateAsync({
          documentId: doc.id,
          file: entry.file,
          label: entry.label || undefined,
        })
      }
      setAddPicked([])
      setAddingFor(null)
      setActionError(null)
      setFeedback(t('documents.filesAdded', { name: doc.name, count: total }))
    } catch (err) {
      setActionError(t(documentErrorKey(err)))
    } finally {
      setProgress(null)
      setBusy(false)
    }
  }

  const download = async (doc, file) => {
    setFeedback(null)
    setActionError(null)
    try {
      const blob = await fetchDocumentContent(doc.id, file.id, 'attachment')
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.file_name
      anchor.click()
      // Defer revocation (review B3): revoking synchronously after click()
      // can pull the blob out from under a download that has not taken its
      // reference yet. A generous timer costs nothing — the blob is only the
      // in-memory copy the browser is already writing out.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      setActionError(t(documentErrorKey(err)))
    }
  }

  const confirmDeleteDoc = (doc) => {
    remove.mutate(
      { id: doc.id },
      {
        onSuccess: () => {
          setConfirmingDocId(null)
          setActionError(null)
          setFeedback(t('documents.deleted', { name: doc.name }))
        },
        onError: (err) => {
          setConfirmingDocId(null)
          setActionError(t(documentErrorKey(err)))
        },
      }
    )
  }

  const confirmDeleteFile = (doc, file) => {
    removeFile.mutate(
      { documentId: doc.id, fileId: file.id },
      {
        onSuccess: () => {
          setFileConfirmKey(null)
          setActionError(null)
          setFeedback(t('documents.fileDeleted', { name: file.file_name }))
        },
        onError: (err) => {
          setFileConfirmKey(null)
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
      {progress && (
        <div role="status" className="px-4 py-3 rounded-lg bg-surface-inset text-sm text-text">
          {t('documents.addingProgress', progress)}
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

      {/* Create — free-text name (#422: no preset list), one-or-more files
          with optional per-file labels, member select (both modes). */}
      <Panel>
        <PanelHead>
          <div>
            <div className="font-semibold">{t('documents.uploadTitle')}</div>
            <div className="text-sm text-text-muted mt-0.5">{t('documents.uploadHint')}</div>
          </div>
        </PanelHead>
        <PanelBody className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">{t('documents.nameLabel')}</span>
            <input
              value={uploadName}
              maxLength={DOCUMENT_NAME_MAX}
              onChange={(e) => setUploadName(e.target.value)}
              placeholder={t('documents.namePlaceholder')}
              aria-label={t('documents.nameLabel')}
              data-testid="document-name"
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <input
              ref={createInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={pickCreateFiles}
              aria-label={t('documents.pickFile')}
            />
            <Button size="sm" variant="secondary" onClick={() => createInputRef.current?.click()}>
              <IconUpload size={15} /> {t('documents.pickFile')}
            </Button>
          </div>
          <PickedFiles
            picked={pickedFiles}
            onLabel={setPickedLabel(setPickedFiles)}
            onRemove={removePicked(setPickedFiles)}
            language={language}
          />
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
            <Button
              size="sm"
              onClick={startUpload}
              disabled={busy || create.isPending || !pickedFiles.length}
            >
              <IconUpload size={15} /> {t('documents.uploadAction')}
            </Button>
          </div>
        </PanelBody>
      </Panel>

      {/* List — the name search replaces the category chips (#422); member
          chips compose with it. */}
      <Panel>
        <PanelHead>
          <div>
            <div className="font-semibold">{t('documents.listTitle')}</div>
            <div className="text-sm text-text-muted mt-0.5">{t('documents.listHint')}</div>
          </div>
        </PanelHead>
        <PanelBody className="flex flex-col gap-3">
          <input
            type="search"
            value={search}
            maxLength={DOCUMENT_NAME_MAX}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('documents.searchPlaceholder')}
            aria-label={t('documents.searchLabel')}
            data-testid="document-search"
          />
          {members.length > 0 && (
            <div role="group" aria-label={t('documents.filterMember')} className="flex flex-wrap items-center gap-2">
              {members.map((member) => (
                <MemberChip
                  key={member.id}
                  member={member}
                  pressed={memberFilter === member.id}
                  onSelect={setMemberFilter}
                />
              ))}
            </div>
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
            {documents.map((doc) =>
              addingFor === doc.id ? (
                <div key={doc.id} className="px-5 py-4 border-b border-border flex flex-col gap-3">
                  <div className="font-medium text-sm">{t('documents.addFilesTitle', { name: doc.name })}</div>
                  <input
                    ref={addInputRef}
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={pickAddFiles}
                    aria-label={t('documents.pickFile')}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <Button size="sm" variant="secondary" onClick={() => addInputRef.current?.click()}>
                      <IconUpload size={15} /> {t('documents.pickFile')}
                    </Button>
                  </div>
                  <PickedFiles
                    picked={addPicked}
                    onLabel={setPickedLabel(setAddPicked)}
                    onRemove={removePicked(setAddPicked)}
                    language={language}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => startAddFiles(doc)}
                      disabled={busy || addFile.isPending || !addPicked.length}
                    >
                      <IconUpload size={15} /> {t('documents.addFilesAction')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAddingFor(null)
                        setAddPicked([])
                      }}
                      disabled={busy}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  memberName={doc.member_id ? (memberNameById.get(doc.member_id) ?? null) : null}
                  onAddFiles={() => {
                    setFeedback(null)
                    setActionError(null)
                    setAddingFor(doc.id)
                    setAddPicked([])
                  }}
                  onViewFile={(d, file) => {
                    setFeedback(null)
                    setActionError(null)
                    setViewing({ doc: d, file })
                  }}
                  onDownloadFile={download}
                  onDeleteFile={(d, file) => confirmDeleteFile(d, file)}
                  onDeleteDoc={() => confirmDeleteDoc(doc)}
                  fileConfirmKey={fileConfirmKey}
                  onToggleFileConfirm={(key) => setFileConfirmKey(fileConfirmKey === key ? null : key)}
                  docConfirmOpen={confirmingDocId === doc.id}
                  onToggleDocConfirm={() => setConfirmingDocId(confirmingDocId === doc.id ? null : doc.id)}
                  removeDocPending={remove.isPending}
                  removeFilePending={removeFile.isPending}
                  language={language}
                />
              )
            )}
          </div>
        )}
      </Panel>

      {viewing && (
        <DocumentViewer
          documentId={viewing.doc.id}
          file={viewing.file}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
