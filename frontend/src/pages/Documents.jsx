import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import {
  DOCUMENTS_BASE_KEY,
  useHouseholds,
  useHouseholdMembers,
  useDocuments,
  useCreateDocument,
  useAddDocumentFile,
  useDeleteDocument,
  useDeleteDocumentFile,
  useUpdateDocumentExpiry,
  useExtractDocumentExpiry,
} from '../lib/queries/index.js'
import {
  ApiError,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_FILES,
  DOCUMENT_NAME_MAX,
  DOCUMENT_DEFAULT_REMIND_DAYS,
  DOCUMENT_REMIND_DAYS_MIN,
  DOCUMENT_REMIND_DAYS_MAX,
  fetchDocumentContent,
  sniffDocumentMime,
} from '../lib/api'
import { DocumentViewer } from './DocumentViewer.jsx'
import { DueSoonSection, ExpiryBadge, ExpiryEditForm, selectDueSoon } from './DocumentExpiry.jsx'
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
  IconCalendarBlank,
  IconSpark,
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
  // The read-date OCR (#433): 402 = no AI provider configured (Settings), a
  // 502 the provider/answer failed — both keep the user in control.
  if (status === 402) return 'documents.errorAiNotConfigured'
  if (status === 502) return 'documents.errorOcr'
  // Rate-limited (the upload and OCR limiters both key per user and send
  // Retry-After): the copy says to wait instead of inviting an immediate
  // retry into the same window (review T4-B6).
  if (status === 429) return 'documents.errorSlowDown'
  return 'documents.errorGeneric'
}

// The interpolated form of the mapping above: most statuses carry no value,
// but a 429's Retry-After is worth surfacing — the user should know when to
// come back (review T4-B6). Errors thrown by code paths that never parse
// headers (test mocks, the blob fetch) have no retryAfterSeconds and fall
// back to the plain slow-down copy.
function documentErrorCopy(t, error) {
  const key = documentErrorKey(error)
  const seconds = error instanceof ApiError ? error.retryAfterSeconds : null
  if (key === 'documents.errorSlowDown' && seconds != null) {
    return t('documents.errorSlowDownRetry', { seconds })
  }
  return t(key)
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
          <span
            className="text-sm text-text-muted truncate max-w-[220px]"
            data-testid="picked-file"
          >
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

// The exact mime trio the expiry-OCR endpoint accepts — mirrors
// EXPIRY_OCR_MIME_TYPES in backend/src/lib/document-ocr.ts (review T4-B4).
// Deliberately NOT a broad /^image\//: a future vault image type must not
// show a "Read date" button whose call answers 415. The two lists are
// independent text (frontend cannot import backend lib code); keep them in
// lockstep.
const EXPIRY_OCR_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

// One file inside its document: name, optional label, size, and the per-file
// actions (view / download / delete — the delete is the same two-step inline
// confirm the document row uses). OCR-readable files also get the OPT-IN
// read-date action (#433): the backend OCRs the image with the user's own AI
// provider and the suggestion prefills the expiry editor — the user still
// saves.
function FileRow({
  file,
  onView,
  onDownload,
  onDelete,
  onReadDate,
  readDateBusy,
  confirmOpen,
  onToggleConfirm,
  busy,
  language,
}) {
  const { t } = useTranslation()
  const ocrSupported = EXPIRY_OCR_IMAGE_TYPES.has(file.content_type)
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
            {t('documents.cancel')}
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
          {ocrSupported && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onReadDate}
              disabled={readDateBusy}
              aria-label={`${t('documents.readDate')}: ${file.file_name}`}
              data-testid="read-date"
            >
              <IconSpark size={15} />
              <span className="hidden sm:inline">
                {readDateBusy ? t('documents.readingDate') : t('documents.readDate')}
              </span>
            </Button>
          )}
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
  onReadDate,
  readDateFileKey,
  onDeleteDoc,
  onEditExpiry,
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
          <div className="font-medium truncate flex items-center gap-2">
            <span className="truncate">{doc.name}</span>
            {/* Expiry chip (#426): computed days, tone by urgency. Absent for
                undated documents — expiry stays opt-in metadata. */}
            <ExpiryBadge days={doc.days_until_expiry} />
          </div>
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
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggleDocConfirm}
              disabled={removeDocPending}
            >
              {t('documents.cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              onClick={onEditExpiry}
              aria-label={`${t('documents.editExpiry')}: ${doc.name}`}
            >
              <IconCalendarBlank size={15} />{' '}
              <span className="hidden sm:inline">{t('documents.editExpiry')}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onAddFiles}
              disabled={doc.files.length >= DOCUMENT_MAX_FILES}
            >
              <IconUpload size={15} />{' '}
              <span className="hidden sm:inline">{t('documents.addFiles')}</span>
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
              onReadDate={() => onReadDate(doc, file)}
              readDateBusy={readDateFileKey === `${doc.id}:${file.id}`}
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
  const queryClient = useQueryClient()
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
  const { data: documentsData, isLoading: documentsLoading } = useDocuments(activeId ? filters : {})
  const documents = (documentsData?.documents ?? []).filter((d) => d.household_id === activeId)

  // Due soon (#426) — derivation lives in DocumentExpiry.jsx (V2-B2); fed
  // the list the page already holds: one fetch, and the section can never
  // disagree with the vault list.
  const dueSoon = useMemo(() => selectDueSoon(documents), [documents])

  const create = useCreateDocument()
  const addFile = useAddDocumentFile()
  const remove = useDeleteDocument()
  const removeFile = useDeleteDocumentFile()
  const updateExpiry = useUpdateDocumentExpiry()
  const extractExpiry = useExtractDocumentExpiry()

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
  // The #426 expiry editor: which document is being edited and its draft.
  const [expiryEditingId, setExpiryEditingId] = useState(null)
  const [expiryDraft, setExpiryDraft] = useState({ expiresOn: '', remindDays: '' })
  // The #433 read-date action: which file is being OCR'd (busy flag) — an
  // explicit per-file call, never automatic (cost control + consent).
  const [readDateFileKey, setReadDateFileKey] = useState(null)

  const openExpiryEdit = (doc) => {
    setFeedback(null)
    setActionError(null)
    setExpiryEditingId(doc.id)
    setExpiryDraft({
      expiresOn: doc.expires_on ?? '',
      remindDays: doc.remind_days_before ?? DOCUMENT_DEFAULT_REMIND_DAYS,
    })
  }

  const closeExpiryEdit = () => {
    setExpiryEditingId(null)
    setExpiryDraft({ expiresOn: '', remindDays: '' })
  }

  // The opt-in read-date action (#433): OCR the file with the user's own AI
  // provider, then prefill the expiry editor with the SUGGESTION. The model
  // never writes — the date only persists when the user saves the editor
  // (saveExpiry → PATCH). A "no date found" answer is feedback, not an error.
  const readDateFromFile = async (doc, file) => {
    setFeedback(null)
    setActionError(null)
    setReadDateFileKey(`${doc.id}:${file.id}`)
    try {
      const result = await extractExpiry.mutateAsync({ documentId: doc.id, fileId: file.id })
      if (result?.expires_on) {
        setExpiryEditingId(doc.id)
        setExpiryDraft({
          expiresOn: result.expires_on,
          remindDays: doc.remind_days_before ?? DOCUMENT_DEFAULT_REMIND_DAYS,
        })
        setFeedback(t('documents.expiryRead', { date: result.expires_on, name: file.file_name }))
      } else {
        setFeedback(t('documents.expiryReadNone', { name: file.file_name }))
      }
    } catch (err) {
      setActionError(documentErrorCopy(t, err))
    } finally {
      setReadDateFileKey(null)
    }
  }

  // Save the expiry draft: a cleared date ALWAYS sends expires_on: null — the
  // server clears the window with it (the invariant), so the window field is
  // irrelevant then (it is disabled while the date is empty). A set date
  // sends the window when filled; an empty window lets the server keep the
  // existing one or apply its 30-day default. The range is pre-checked here
  // (mirroring the server's 1..365) so a bad value fails in copy instead of a
  // generic 400.
  const saveExpiry = async (doc) => {
    setFeedback(null)
    setActionError(null)
    const dateValue = expiryDraft.expiresOn || null
    let payload
    if (dateValue === null) {
      payload = { expires_on: null }
    } else {
      const windowValue =
        expiryDraft.remindDays === '' || expiryDraft.remindDays === null
          ? undefined
          : Number(expiryDraft.remindDays)
      if (
        windowValue !== undefined &&
        (!Number.isInteger(windowValue) ||
          windowValue < DOCUMENT_REMIND_DAYS_MIN ||
          windowValue > DOCUMENT_REMIND_DAYS_MAX)
      ) {
        setActionError(t('documents.errorRemindRange'))
        return
      }
      payload = { expires_on: dateValue }
      if (windowValue !== undefined) {
        payload.remind_days_before = windowValue
      }
    }
    try {
      await updateExpiry.mutateAsync({ id: doc.id, payload })
      closeExpiryEdit()
      setFeedback(t('documents.expirySaved', { name: doc.name }))
    } catch (err) {
      setActionError(documentErrorCopy(t, err))
    }
  }

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

  // Shared picked-batch validation (review B2 #422): empty, the per-document
  // cap (capOffset = files the document already holds), the size cap, and —
  // review A4 #422 — a magic-byte sniff of every picked file. The sniff reads
  // the first 12 bytes up front so a renamed .txt fails BEFORE the create,
  // not mid-loop with a partial document stranded; the server re-sniffs.
  const validatePicked = async (entries, capOffset = 0) => {
    if (entries.length === 0) return t('documents.errorNoFile')
    if (entries.length + capOffset > DOCUMENT_MAX_FILES) {
      return t('documents.errorTooManyFiles')
    }
    if (entries.some((entry) => entry.file.size > DOCUMENT_MAX_BYTES)) {
      return t('documents.errorTooLarge')
    }
    for (const entry of entries) {
      const head = new Uint8Array(await entry.file.slice(0, 12).arrayBuffer())
      // Review delta D2 #422: the sniffed kind must ALSO agree with the
      // declared type — a PNG named .jpg would otherwise 415 mid-loop. The
      // server stays the authority; this mirrors its declared-vs-actual 415.
      const sniffed = sniffDocumentMime(head)
      if (!sniffed || sniffed !== entry.file.type) return t('documents.errorType')
    }
    return null
  }

  // The shared sequential upload runner (review B2 #422): picked entries ride
  // add-file one by one. Sequential, not parallel: the backend orders by max
  // (sort_order) + 1, so parallel calls could race the order; awaiting each
  // keeps pick order = upload order, and the progress line reflects exactly
  // where a failure stopped. Owns the busy/progress bookkeeping and the error
  // mapping both flows shared, and refreshes the vault cache ONCE per run
  // (review B3 #422 — per-settle invalidation meant ~N list refetches for one
  // multi-file upload).
  const runSequentialUploads = async ({ documentId, entries, startIndex = 0, onDone }) => {
    setBusy(true)
    try {
      const total = entries.length
      for (let i = startIndex; i < total; i++) {
        setProgress({ current: i + 1, total })
        const entry = entries[i]
        await addFile.mutateAsync({
          documentId,
          file: entry.file,
          label: entry.label || undefined,
        })
      }
      setActionError(null)
      onDone()
    } catch (err) {
      setActionError(documentErrorCopy(t, err))
    } finally {
      setProgress(null)
      setBusy(false)
      // Review delta D1 #422: the BARE base key — react-query prefix-matches
      // array keys, so this reaches EVERY filtered view. documentsQueryKey()
      // here would be one exact filter object and an active q/member filter
      // would not match it, leaving the visible list stale.
      queryClient.invalidateQueries({ queryKey: DOCUMENTS_BASE_KEY })
    }
  }

  // Create → then the remaining files ride the shared runner.
  const startUpload = async () => {
    setFeedback(null)
    setActionError(null)
    const name = uploadName.trim()
    if (!name) {
      setActionError(t('documents.errorNoName'))
      return
    }
    const invalid = await validatePicked(pickedFiles)
    if (invalid) {
      setActionError(invalid)
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
      await runSequentialUploads({
        documentId: created?.document?.id,
        entries: pickedFiles,
        startIndex: 1,
        onDone: () => {
          setPickedFiles([])
          setUploadName('')
          setFeedback(t('documents.uploaded', { name }))
        },
      })
    } catch (err) {
      setActionError(documentErrorCopy(t, err))
    } finally {
      setBusy(false)
    }
  }

  const startAddFiles = async (doc) => {
    setFeedback(null)
    setActionError(null)
    const invalid = await validatePicked(addPicked, doc.files.length)
    if (invalid) {
      setActionError(invalid)
      return
    }
    await runSequentialUploads({
      documentId: doc.id,
      entries: addPicked,
      startIndex: 0,
      onDone: () => {
        setAddPicked([])
        setAddingFor(null)
        setFeedback(t('documents.filesAdded', { name: doc.name, count: addPicked.length }))
      },
    })
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
      setActionError(documentErrorCopy(t, err))
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
          setActionError(documentErrorCopy(t, err))
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
          setActionError(documentErrorCopy(t, err))
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

      {/* Due soon (#426) — documents inside their reminder window, soonest
          expiry first. Rendered only when non-empty: an all-clear vault has
          nothing to say here. Presentation lives in DocumentExpiry.jsx. */}
      {dueSoon.length > 0 && <DueSoonSection docs={dueSoon} memberNameById={memberNameById} />}

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
            <div
              role="group"
              aria-label={t('documents.filterMember')}
              className="flex flex-wrap items-center gap-2"
            >
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
                  <div className="font-medium text-sm">
                    {t('documents.addFilesTitle', { name: doc.name })}
                  </div>
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
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => addInputRef.current?.click()}
                    >
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
                      {t('documents.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div key={doc.id}>
                  <DocumentRow
                    doc={doc}
                    memberName={doc.member_id ? (memberNameById.get(doc.member_id) ?? null) : null}
                    onAddFiles={() => {
                      setFeedback(null)
                      setActionError(null)
                      setAddingFor(doc.id)
                      setAddPicked([])
                    }}
                    onEditExpiry={() => openExpiryEdit(doc)}
                    onViewFile={(d, file) => {
                      setFeedback(null)
                      setActionError(null)
                      setViewing({ doc: d, file })
                    }}
                    onDownloadFile={download}
                    onDeleteFile={(d, file) => confirmDeleteFile(d, file)}
                    onReadDate={readDateFromFile}
                    readDateFileKey={readDateFileKey}
                    onDeleteDoc={() => confirmDeleteDoc(doc)}
                    fileConfirmKey={fileConfirmKey}
                    onToggleFileConfirm={(key) =>
                      setFileConfirmKey(fileConfirmKey === key ? null : key)
                    }
                    docConfirmOpen={confirmingDocId === doc.id}
                    onToggleDocConfirm={() =>
                      setConfirmingDocId(confirmingDocId === doc.id ? null : doc.id)
                    }
                    removeDocPending={remove.isPending}
                    removeFilePending={removeFile.isPending}
                    language={language}
                  />
                  {expiryEditingId === doc.id && (
                    <ExpiryEditForm
                      doc={doc}
                      draft={expiryDraft}
                      onDraftChange={setExpiryDraft}
                      onSave={() => saveExpiry(doc)}
                      onCancel={closeExpiryEdit}
                      saving={updateExpiry.isPending}
                    />
                  )}
                </div>
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
