import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../lib/api'
import {
  useDecideAlias,
  useProductIdentity,
  useRenameProduct,
  useRevertRename,
} from '../lib/queries/products.js'
import { Panel, PanelBody } from './Panel.jsx'
import { Button } from './Button.jsx'
import { Chip } from './Chip.jsx'
import { IconCheck, IconWarning } from './icons.jsx'

// Admin canonical product rename + revert (ahaqqu/RumaQ#423, PR C). ONE
// component reused by both admin surfaces: the price explorer's product detail
// and the match review row's canonical entry side. The identity read is the
// source of truth for the optimistic `expectedMetadataVersion`; the server owns
// every rule, this form only maps its answers to inline copy:
//   duplicate_name  -> hard stop, list the conflicts, no acknowledgement path
//   similar_name    -> list the warnings, offer an explicit "rename anyway"
//   stale_product   -> re-read the identity, keep the typed name, never resubmit
//   stale_revert    -> re-read the identity, say the history moved on
// The backend lib (canonical-products.ts) is the contract; no server string is
// ever rendered (the Household.jsx error-vocabulary precedent).
//
// #489 adds candidate-alias decisions to the same alias list: the alias id is
// the target, approve/reject is the verb, and a row — not the form — owns the
// busy state, so the rename fields stay usable while a decision is in flight.
// The decision's only 409 is `alias_state` (someone else already decided the
// row), mapped to a refetch plus "already decided", never to backend prose.

const REASON_MAX = 200
// Mirrors the backend's PRODUCT_NAME_MAX: a longer name is a 400, so the input
// stops at the same ceiling instead of inviting one.
const NAME_MAX = 500

const STATUS_KEY = {
  canonical: 'rename.statusCanonical',
  provisional: 'rename.statusProvisional',
  needs_review: 'rename.statusNeedsReview',
}

const ALIAS_STATUS_KEY = {
  candidate: 'rename.aliasStatusCandidate',
  approved: 'rename.aliasStatusApproved',
  rejected: 'rename.aliasStatusRejected',
}

const ALIAS_SOURCE_KEY = {
  ocr: 'rename.aliasSourceOcr',
  catalog: 'rename.aliasSourceCatalog',
  admin: 'rename.aliasSourceAdmin',
}

const CONFLICT_SOURCE_KEY = {
  product: 'rename.conflictSourceProduct',
  alias: 'rename.conflictSourceAlias',
}

// Only a 409 body carries a machine-readable `error` code; status alone decides
// the rest (a 400 is a validation rejection whose backend message is English
// prose, so it becomes the localized validation copy).
function noticeFromError(error) {
  const status = error instanceof ApiError ? error.status : undefined
  const body = error instanceof ApiError ? error.body : undefined
  const code = body && typeof body === 'object' ? body.error : undefined
  if (status === 409 && code === 'duplicate_name') {
    return { kind: 'duplicate', conflicts: body.conflicts ?? [] }
  }
  if (status === 409 && code === 'similar_name') {
    return { kind: 'similar', warnings: body.warnings ?? [] }
  }
  if (status === 409 && code === 'stale_product') return { kind: 'stale' }
  if (status === 404) return { kind: 'notFound' }
  if (status === 403) return { kind: 'forbidden' }
  if (status === 400) return { kind: 'invalid' }
  return { kind: 'error' }
}

// The alias decision's answer vocabulary (#489). `alias_state` is the CAS loss:
// the row was decided while it was on screen, so the caller refetches and says
// so. Everything else is a plain localized failure.
function aliasNoticeFromError(error) {
  const status = error instanceof ApiError ? error.status : undefined
  const body = error instanceof ApiError ? error.body : undefined
  const code = body && typeof body === 'object' ? body.error : undefined
  if (status === 409 && code === 'alias_state') {
    return { kind: 'alreadyDecided', currentStatus: body.currentStatus }
  }
  if (status === 404) return { kind: 'aliasNotFound' }
  if (status === 403) return { kind: 'aliasForbidden' }
  return { kind: 'aliasError' }
}

function SimilarWarnings({ warnings }) {
  const { t } = useTranslation()
  return (
    <ul className="mt-1 flex flex-col gap-0.5" data-testid="rename-similar-list">
      {(warnings ?? []).map((warning, index) => (
        <li key={`${warning.productKey}-${index}`} className="text-sm">
          {t('rename.similarRow', {
            name: warning.name,
            pct: Math.round((warning.similarity ?? 0) * 100),
          })}
        </li>
      ))}
    </ul>
  )
}

// The form's one result slot: success confirmations, the three overridable /
// terminal conflicts, and the revert notices. A new attempt replaces the old
// notice, so a message from a previous name never lingers.
function RenameNotice({ notice, busy, canAcknowledge, onAcknowledge }) {
  const { t } = useTranslation()
  if (!notice) return null

  if (notice.kind === 'success' || notice.kind === 'revertSuccess') {
    const renamed = notice.kind === 'success'
    return (
      <div
        role="status"
        data-testid="rename-success"
        className="mt-3 rounded-lg bg-ok-soft text-sm text-text px-4 py-3"
      >
        <div className="flex items-center gap-2 font-medium text-ok">
          <IconCheck size={16} />
          {t(renamed ? 'rename.successTitle' : 'rename.revertSuccessTitle')}
        </div>
        <p className="mt-1">
          {renamed
            ? t('rename.successBody', { version: notice.indexVersion ?? '—' })
            : t('rename.revertSuccessBody', {
                name: notice.name,
                version: notice.indexVersion ?? '—',
              })}
        </p>
        {renamed && (notice.warnings?.length ?? 0) > 0 && (
          <p className="mt-1 text-xs text-text-muted">{t('rename.similarAcknowledged')}</p>
        )}
      </div>
    )
  }

  if (notice.kind === 'duplicate') {
    return (
      <div
        role="alert"
        data-testid="rename-duplicate"
        className="mt-3 rounded-lg bg-danger-soft text-sm text-danger px-4 py-3"
      >
        <div className="flex items-center gap-2 font-medium">
          <IconWarning size={16} />
          {t('rename.duplicateTitle')}
        </div>
        <p className="mt-1">{t('rename.duplicateDesc')}</p>
        <ul className="mt-1 flex flex-col gap-0.5" data-testid="rename-conflict-list">
          {(notice.conflicts ?? []).map((conflict, index) => (
            <li key={`${conflict.productKey}-${index}`}>
              {t('rename.duplicateConflict', {
                name: conflict.name,
                source: t(CONFLICT_SOURCE_KEY[conflict.source] ?? 'rename.conflictSourceProduct'),
              })}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (notice.kind === 'similar') {
    return (
      <div
        role="alert"
        data-testid="rename-similar"
        className="mt-3 rounded-lg bg-warn-soft text-sm text-warn px-4 py-3"
      >
        <div className="flex items-center gap-2 font-medium">
          <IconWarning size={16} />
          {t('rename.similarTitle')}
        </div>
        <p className="mt-1">{t('rename.similarDesc')}</p>
        <SimilarWarnings warnings={notice.warnings} />
        {/* The acknowledgement waives the warnings above, so it only exists
            while the draft still holds the name they were raised for. Once the
            name is edited the plain submit asks the server again. */}
        {canAcknowledge && (
          <Button
            variant="danger"
            size="sm"
            className="mt-2"
            disabled={busy}
            onClick={onAcknowledge}
          >
            {t('rename.similarAnyway')}
          </Button>
        )}
      </div>
    )
  }

  if (notice.kind === 'stale' || notice.kind === 'revertStale') {
    return (
      <div
        role="alert"
        data-testid={notice.kind === 'stale' ? 'rename-stale' : 'rename-revert-stale'}
        className="mt-3 rounded-lg bg-warn-soft text-sm text-warn px-4 py-3"
      >
        <div className="flex items-center gap-2 font-medium">
          <IconWarning size={16} />
          {t(notice.kind === 'stale' ? 'rename.staleTitle' : 'rename.revertStaleTitle')}
        </div>
        <p className="mt-1">
          {t(notice.kind === 'stale' ? 'rename.staleDesc' : 'rename.revertStaleDesc')}
        </p>
      </div>
    )
  }

  const key =
    notice.kind === 'notFound'
      ? 'rename.errorNotFound'
      : notice.kind === 'forbidden'
        ? 'rename.errorForbidden'
        : notice.kind === 'invalid'
          ? 'rename.errorInvalid'
          : 'rename.errorGeneric'
  return (
    <p role="alert" data-testid="rename-error" className="mt-3 text-sm text-danger">
      {t(key)}
    </p>
  )
}

// The alias section's one result slot (#489). Kept apart from RenameNotice:
// a decision result belongs next to the rows it changed, and the rename
// notice's focus contract must not be disturbed by a list action.
function AliasDecisionNotice({ notice }) {
  const { t } = useTranslation()
  if (notice.kind === 'approved' || notice.kind === 'rejected') {
    const approved = notice.kind === 'approved'
    return (
      <div
        role="status"
        data-testid="alias-decision-notice"
        className="mt-2 flex items-start gap-2 rounded-lg bg-ok-soft px-3 py-2 text-sm text-text"
      >
        <IconCheck size={16} className="mt-0.5 shrink-0 text-ok" />
        <span>
          {t(approved ? 'rename.aliasApproveSuccess' : 'rename.aliasRejectSuccess', {
            name: notice.name,
            version: notice.indexVersion ?? '—',
          })}
        </span>
      </div>
    )
  }

  if (notice.kind === 'alreadyDecided') {
    return (
      <div
        role="alert"
        data-testid="alias-decision-notice"
        className="mt-2 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn"
      >
        <IconWarning size={16} className="mt-0.5 shrink-0" />
        <span>
          {t('rename.aliasAlreadyDecided', {
            status: t(ALIAS_STATUS_KEY[notice.currentStatus] ?? 'rename.aliasStatusCandidate'),
          })}
        </span>
      </div>
    )
  }

  const key =
    notice.kind === 'aliasNotFound'
      ? 'rename.aliasErrorNotFound'
      : notice.kind === 'aliasForbidden'
        ? 'rename.aliasErrorForbidden'
        : 'rename.aliasErrorGeneric'
  return (
    <p role="alert" data-testid="alias-decision-notice" className="mt-2 text-sm text-danger">
      {t(key)}
    </p>
  )
}

/**
 * Canonical product rename form. `onClose` collapses the surface that opened
 * it; without it the Cancel button still resets the local draft. `isAdmin`
 * gates the alias decision actions — both current surfaces already render this
 * form only for admins, but the actions stay hidden if that ever stops being
 * true (or if the form is reused on a shopper surface).
 */
export function ProductRenameForm({ productKey, onClose, isAdmin = false }) {
  const { t } = useTranslation()
  const nameId = useId()
  const previewId = useId()
  const reasonId = useId()
  const noticeId = useId()
  const noticeRef = useRef(null)
  // null means "follow the loaded name": the input starts pre-filled with the
  // current name but is not pinned, so a stale re-read moves the untouched
  // prefill. A typed value pins it (the stale_product path keeps it).
  const [draftName, setDraftName] = useState(null)
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState(null)
  // Alias decisions are per-row server writes, deliberately separate from the
  // rename draft: `decidingAliases` maps an alias id to the action in flight
  // (one row in flight never blocks another row or the form), and
  // `aliasNotice` is the list's own result slot.
  const [decidingAliases, setDecidingAliases] = useState({})
  const [aliasNotice, setAliasNotice] = useState(null)
  // Reject is the one decision that asks twice (#496): a rejected alias is
  // terminal (candidate-only CAS, no reset route, ingest never rewrites the
  // status), so one stray click permanently removes a spelling from matching,
  // silently. Approve stays one click — a wrong approve is visible in the list
  // and correctable by a later manual fix. Only an alias id can be armed, never
  // a set: one row is armed at a time by construction, so the prompt can never
  // follow the cursor to another row.
  const [armedAliasId, setArmedAliasId] = useState(null)
  // Focus follows the answer: a keyboard user must land on the explanation (a
  // duplicate/similar/stale 409 or the success block), and the submit button
  // disables itself after a success, which would otherwise drop focus to
  // <body>. The notice's own role="alert"/"status" still does the announcement.
  useEffect(() => {
    if (notice) noticeRef.current?.focus()
  }, [notice])
  const identityQuery = useProductIdentity(productKey, { enabled: Boolean(productKey) })
  const rename = useRenameProduct()
  const revert = useRevertRename()
  const aliasDecision = useDecideAlias()

  const identity = identityQuery.data
  const product = identity?.product
  const currentName = product?.name ?? ''
  const newName = draftName ?? currentName
  const trimmedName = newName.trim()
  const busy = rename.isPending || revert.isPending
  // A re-read replaces the list the arming was about: someone else may have
  // decided the row, or the product may have moved on. Keeping the prompt open
  // would confirm a decision against evidence nobody has looked at, so the
  // refetch (and a remount/leave, which drops the state with the component)
  // disarms. `dataUpdatedAt` catches a re-read whose payload is unchanged
  // (React Query's structural sharing keeps the same `data` reference then);
  // `identity` catches a payload that did move.
  useEffect(() => {
    setArmedAliasId(null)
  }, [identity, identityQuery.dataUpdatedAt])

  // Revert is a linear history: only the rename that produced the current
  // version can be compensated (the backend's own rule), so an older or
  // already-reverted rename never offers the button.
  const latestAudit = identity?.audit?.[0] ?? null
  const revertable =
    latestAudit?.action === 'rename' &&
    latestAudit.metadataVersionAfter === product?.metadataVersion &&
    latestAudit.newName === currentName
      ? latestAudit
      : null

  // A duplicate name is a hard stop (no acknowledgement path exists, merges are
  // a non-goal): the submit stays disabled until the name changes, because the
  // same name can only 409 again. A committed name is equally final — the form
  // stays open showing it, and resubmitting it would only 400.
  const duplicateBlocked = notice?.kind === 'duplicate' && trimmedName === notice.name
  // A similar-name 409 answers exactly one name. Editing the draft makes that
  // answer stale: acknowledging it would waive warnings about a name nobody
  // has seen, so the override only exists while the two still match.
  const canAcknowledge = notice?.kind === 'similar' && trimmedName === notice.name
  // These are answers about the name field; stale/404/403 are about the product
  // or the route, so they carry no field association.
  const nameInvalid =
    notice?.kind === 'duplicate' || notice?.kind === 'similar' || notice?.kind === 'invalid'
  const committed =
    notice?.kind === 'success' || notice?.kind === 'revertSuccess' ? notice.name : null
  const canSubmit =
    Boolean(product) &&
    trimmedName.length > 0 &&
    trimmedName !== currentName &&
    trimmedName !== committed &&
    !busy &&
    !duplicateBlocked

  function submitName(acknowledgeWarnings = false) {
    if (!product || !trimmedName) return
    const attemptedName = trimmedName
    setNotice(null)
    rename.mutate(
      {
        productKey,
        canonicalName: attemptedName,
        expectedMetadataVersion: product.metadataVersion,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(acknowledgeWarnings ? { acknowledgeWarnings: true } : {}),
      },
      {
        onSuccess: (result) => {
          const committed = result?.product?.name ?? attemptedName
          setDraftName(committed)
          setReason('')
          setNotice({
            kind: 'success',
            name: committed,
            indexVersion: result?.indexVersion,
            warnings: result?.warnings ?? [],
          })
        },
        onError: (error) => {
          const mapped = noticeFromError(error)
          // Someone else wrote this product: re-read the identity so the
          // optimistic version the next submit needs is the current one. The
          // typed name stays, nothing resubmits on its own.
          if (mapped.kind === 'stale') identityQuery.refetch()
          setNotice({ ...mapped, name: attemptedName })
        },
      }
    )
  }

  function handleSubmit(event) {
    event.preventDefault()
    if (!canSubmit) return
    submitName(false)
  }

  function handleCancel() {
    setDraftName(null)
    setReason('')
    setNotice(null)
    // The form's own cancel leaves the surface (or resets it), so an armed
    // reject must not outlive it.
    setArmedAliasId(null)
    onClose?.()
  }

  function handleRevert() {
    if (!revertable) return
    const restoreName = revertable.oldName
    if (!window.confirm(t('rename.revertConfirm', { name: restoreName }))) return
    setNotice(null)
    revert.mutate(
      {
        productKey,
        auditId: revertable.id,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      {
        onSuccess: (result) => {
          const restored = result?.product?.name ?? restoreName
          setDraftName(restored)
          setReason('')
          setNotice({
            kind: 'revertSuccess',
            name: restored,
            indexVersion: result?.indexVersion,
          })
        },
        onError: (error) => {
          const status = error instanceof ApiError ? error.status : undefined
          const body = error instanceof ApiError ? error.body : undefined
          if (status === 409 && body?.error === 'stale_revert') {
            identityQuery.refetch()
            setNotice({ kind: 'revertStale' })
            return
          }
          setNotice(noticeFromError(error))
        },
      }
    )
  }

  // A candidate-alias decision (#489). The row being acted on is the only thing
  // that goes busy: `busy` above stays false, so a rename can still be typed
  // and submitted while the decision is in flight. The per-row guard plus the
  // disabled buttons make a double submit of the same row impossible.
  function decideAlias(alias, action) {
    if (!alias?.id || !isAdmin || decidingAliases[alias.id]) return
    // Every decision ends any armed prompt, whichever row owned it: the
    // rejected row is now being written, and a second row's prompt must not
    // survive an action that changes the list.
    setArmedAliasId(null)
    setAliasNotice(null)
    setDecidingAliases((previous) => ({ ...previous, [alias.id]: action }))
    aliasDecision.mutate(
      { productKey, aliasId: alias.id, action },
      {
        onSuccess: (result) => {
          setAliasNotice({
            kind: action === 'approve' ? 'approved' : 'rejected',
            name: result?.alias?.name ?? alias.name,
            indexVersion: result?.indexVersion,
          })
        },
        onError: (error) => {
          const mapped = aliasNoticeFromError(error)
          // The identity is the only source of truth for a decision this form
          // lost: `alias_state` means another admin decided the row while it
          // was on screen, and a 404 means the row (or its product) is gone.
          // Both re-read the list, so "already decided" and "no longer exists
          // — the list has been refreshed" are true when shown.
          if (mapped.kind === 'alreadyDecided' || mapped.kind === 'aliasNotFound') {
            identityQuery.refetch()
          }
          setAliasNotice(mapped)
        },
        onSettled: () => {
          setDecidingAliases((previous) => {
            if (!previous[alias.id]) return previous
            const next = { ...previous }
            delete next[alias.id]
            return next
          })
        },
      }
    )
  }

  // Reject's first click only arms the row (#496). Nothing is sent, the alias
  // stays a candidate, and the row swaps its Reject label for the confirm
  // prompt plus a cancel. Arming another row replaces the armed id, which is
  // the "choosing another row disarms" rule; a busy row cannot be armed again.
  // Unlike `decideAlias` this does not clear `aliasNotice`: arming writes
  // nothing, so it must not discard the receipt of a decision already made.
  function armReject(alias) {
    if (!alias?.id || !isAdmin || decidingAliases[alias.id]) return
    setArmedAliasId(alias.id)
  }

  function disarmReject() {
    setArmedAliasId(null)
  }

  // The second click. Only the armed row can confirm, so a keyboard user cannot
  // fire a reject by tabbing onto a button that was never armed — and only a
  // gesture of its own can confirm: the second click of a double-click reports
  // `detail` 2 because it is the same gesture as the click that armed the row,
  // and confirming it would put the terminal decision back one stray
  // double-click (or one chattering mouse) away. Keyboard activations report 0.
  function confirmReject(alias, clickCount) {
    if (!alias?.id || armedAliasId !== alias.id || clickCount > 1) return
    decideAlias(alias, 'reject')
  }

  if (identityQuery.isLoading) {
    return (
      <Panel data-testid="product-rename-form">
        <PanelBody>
          <p className="text-sm text-text-muted" aria-busy="true">
            {t('rename.loading')}
          </p>
        </PanelBody>
      </Panel>
    )
  }

  if (identityQuery.isError || !product) {
    return (
      <Panel data-testid="product-rename-form">
        <PanelBody>
          <p role="alert" className="text-sm text-danger">
            {t('rename.loadError')}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => identityQuery.refetch()}>
              {t('rename.retry')}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              {t('rename.cancel')}
            </Button>
          </div>
        </PanelBody>
      </Panel>
    )
  }

  const aliases = identity.aliases ?? []
  // The one row whose Reject was clicked once (#496). Looked up by id rather
  // than kept as an object so a re-read that drops the row leaves nothing to
  // confirm — and so the prompt always shows the alias name currently on
  // screen, never the one that was armed a refetch ago.
  const armedAlias = armedAliasId
    ? (aliases.find((alias) => alias.id === armedAliasId) ?? null)
    : null
  // The decision actions exist only for an admin, only on a row that still has
  // a decision to make, and only when the payload carries the id the routes
  // address (a candidate without an id cannot be acted on; hiding beats a
  // dead button).
  const showAliasActions =
    isAdmin && aliases.some((alias) => alias.status === 'candidate' && alias.id)

  return (
    <Panel data-testid="product-rename-form" aria-busy={busy || undefined}>
      <PanelBody>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{t('rename.title')}</h3>
          <Chip variant="default">
            {t(STATUS_KEY[product.status] ?? 'rename.statusProvisional')}
          </Chip>
          {identity.stats && (
            <span className="text-xs text-text-muted">
              {t('rename.observations', { count: identity.stats.observations ?? 0 })} ·{' '}
              {t('rename.stores', { count: identity.stats.stores ?? 0 })}
            </span>
          )}
        </div>

        <p className="mt-3 text-sm">
          <span className="text-text-muted">{t('rename.currentName')}: </span>
          <span className="font-medium" data-testid="rename-current-name">
            {currentName}
          </span>
          {product.brand && <span className="text-text-muted"> · {product.brand}</span>}
          {product.unit && <span className="text-text-muted"> · {product.unit}</span>}
        </p>

        <form className="mt-3 flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-sm font-medium text-text-muted">
              {t('rename.newName')}
            </label>
            <input
              id={nameId}
              value={newName}
              maxLength={NAME_MAX}
              aria-invalid={nameInvalid || undefined}
              aria-describedby={notice ? `${previewId} ${noticeId}` : previewId}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder={t('rename.newNamePlaceholder')}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <p id={previewId} className="text-xs text-text-muted" data-testid="rename-preview">
              {!trimmedName
                ? t('rename.previewEmpty')
                : trimmedName === currentName
                  ? t('rename.previewSame')
                  : t('rename.previewOldToNew', {
                      oldName: currentName,
                      newName: trimmedName,
                    })}
            </p>
          </div>

          {notice && (
            <div
              id={noticeId}
              ref={noticeRef}
              tabIndex={-1}
              data-testid="rename-notice"
              className="outline-none"
            >
              <RenameNotice
                notice={notice}
                busy={busy}
                canAcknowledge={canAcknowledge}
                onAcknowledge={() => submitName(true)}
              />
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor={reasonId} className="text-sm font-medium text-text-muted">
              {t('rename.reason')}
            </label>
            <textarea
              id={reasonId}
              value={reason}
              rows={2}
              maxLength={REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t('rename.reasonPlaceholder')}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <span className="text-xs text-text-muted tabular-nums">
              {t('rename.reasonCount', { count: reason.length })}
            </span>
          </div>

          <div>
            <div className="text-sm font-medium text-text-muted">{t('rename.aliases')}</div>
            {showAliasActions && (
              <p className="mt-1 text-xs text-text-muted">{t('rename.aliasDecisionHint')}</p>
            )}
            {/* The armed prompt is a spoken change too: the buttons swap under
                the cursor and a screen reader gets no other cue. The inline
                notices announce themselves with role="status"; this keeps the
                same channel while the prompt is open, and empty otherwise. */}
            <div className="sr-only" role="status" data-testid="alias-reject-announcement">
              {armedAlias ? t('rename.aliasRejectArmed', { name: armedAlias.name }) : ''}
            </div>
            {aliases.length === 0 ? (
              <p className="text-xs text-text-muted mt-1">{t('rename.aliasesEmpty')}</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1" data-testid="rename-aliases">
                {aliases.map((alias, index) => {
                  const pendingAction = decidingAliases[alias.id]
                  const rowBusy = Boolean(pendingAction)
                  const decidable = isAdmin && alias.status === 'candidate' && Boolean(alias.id)
                  const armed = armedAliasId === alias.id
                  return (
                    <li
                      key={alias.id ?? `${alias.storeSlug}-${alias.name}-${index}`}
                      className="flex flex-wrap items-center gap-2 text-sm"
                      aria-busy={rowBusy || undefined}
                      data-armed={armed || undefined}
                    >
                      <span className="font-medium">{alias.name}</span>
                      <span className="text-xs text-text-muted">{alias.storeSlug}</span>
                      <Chip variant="default">
                        {t(ALIAS_STATUS_KEY[alias.status] ?? 'rename.aliasStatusCandidate')}
                      </Chip>
                      <Chip variant="loc">
                        {t(ALIAS_SOURCE_KEY[alias.source] ?? 'rename.aliasSourceOcr')}
                      </Chip>
                      {decidable && (
                        <span className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={rowBusy}
                            aria-label={t('rename.aliasApproveLabel', { name: alias.name })}
                            onClick={() => decideAlias(alias, 'approve')}
                          >
                            {pendingAction === 'approve'
                              ? t('rename.aliasApproving')
                              : t('rename.aliasApprove')}
                          </Button>
                          {/* Reject is the terminal decision, so it asks twice:
                              the first click only arms this row and the second
                              (the same button, now the confirm prompt) sends it.
                              Approve above stays one click. */}
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={rowBusy}
                            aria-label={t(
                              armed ? 'rename.aliasRejectConfirmLabel' : 'rename.aliasRejectLabel',
                              { name: alias.name }
                            )}
                            onClick={(event) =>
                              armed ? confirmReject(alias, event.detail) : armReject(alias)
                            }
                          >
                            {pendingAction === 'reject'
                              ? t('rename.aliasRejecting')
                              : armed
                                ? t('rename.aliasRejectConfirm')
                                : t('rename.aliasReject')}
                          </Button>
                          {armed && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={rowBusy}
                              aria-label={t('rename.aliasRejectCancelLabel', { name: alias.name })}
                              onClick={disarmReject}
                            >
                              {t('rename.cancel')}
                            </Button>
                          )}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {aliasNotice && <AliasDecisionNotice notice={aliasNotice} />}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {rename.isPending ? t('rename.submitBusy') : t('rename.submit')}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={handleCancel}>
              {t('rename.cancel')}
            </Button>
          </div>
        </form>

        {revertable && (
          <div className="mt-4 border-t border-border pt-3">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              {t('rename.revertTitle')}
            </div>
            <p className="mt-1 text-sm">
              {t('rename.revertLatest', {
                oldName: revertable.oldName,
                newName: revertable.newName,
              })}
            </p>
            <Button
              variant="danger"
              size="sm"
              className="mt-2"
              disabled={busy}
              onClick={handleRevert}
            >
              {revert.isPending ? t('rename.revertBusy') : t('rename.revertAction')}
            </Button>
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
