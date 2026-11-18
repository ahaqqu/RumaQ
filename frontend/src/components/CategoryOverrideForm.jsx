import { useId, useRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../lib/api'
import { useProductIdentity } from '../lib/queries/products.js'
import { useSetReviewCategory, useTaxonomyBuckets } from '../lib/queries/review.js'
import { Panel, PanelBody } from './Panel.jsx'
import { Button } from './Button.jsx'
import { Chip } from './Chip.jsx'
import { CategoryPicker } from './CategoryPicker.jsx'
import { CategoryRevertBlock } from './CategoryRevertBlock.jsx'
import { IconWarning } from './icons.jsx'

// The human category override (ahaqqu/RumaQ#728) — the act the taxonomy ack is
// not ("seen — the assigned category stands" vs "the category is wrong, set the
// right one"). ONE component, the ProductRenameForm pattern, mounted from the
// review row's taxonomy card:
//
//   - the identity read (GET /api/admin/products/:productKey) is the source of
//     truth: the optimistic expectedMetadataVersion is not needed here (the
//     override's CAS is the from-value category), but the CURRENT category the
//     save-disabled check and the provenance line read comes from it — the
//     frozen pair blob can predate a correction;
//   - the picker offers quick choices first (the assigned category, the rules
//     head's answer), then the sealed 49-bucket vocabulary from the buckets
//     route — the frontend never imports @rumaq/contract, so the list rides
//     GET /api/admin/review/taxonomy/buckets;
//   - the server owns every rule (sealed-vocabulary membership, the
//     category-unchanged 400, the from-value CAS); this form only maps the
//     answers to inline copy — no server string is ever rendered (the
//     Household error-vocabulary precedent):
//       category_unknown   -> the picked slug is not in the sealed list (a
//                             stale page or a taxonomy bump mid-session); the
//                             draft stays, the admin re-picks
//       category_unchanged -> the backstop the disabled Save usually prevents
//       stale_category     -> the from-value CAS lost: re-read the identity,
//                             keep the picked slug, never auto-resubmit
//   - the revert block (CategoryRevertBlock) renders under the picker for an
//     admin — the compensating action for a mistaken override, dual-surface
//     with the product detail (the reconciled design's PM-over-architect
//     note, adopted by the manager);
//   - saving closes the panel: the row's own decided state + provenance chips
//     ARE the success notice (the queue re-read replaces the optimistic flip
//     with the server's answer).

const REASON_MAX = 200

function noticeFromError(error) {
  const status = error instanceof ApiError ? error.status : undefined
  const body = error instanceof ApiError ? error.body : undefined
  const code = body && typeof body === 'object' ? body.error : undefined
  if (status === 409 && code === 'stale_category') return { kind: 'stale' }
  if (status === 400 && code === 'category_unknown') return { kind: 'unknown' }
  if (status === 400 && code === 'category_unchanged') return { kind: 'unchanged' }
  if (status === 404) return { kind: 'notFound' }
  if (status === 403) return { kind: 'forbidden' }
  if (status === 400) return { kind: 'invalid' }
  return { kind: 'error' }
}

function OverrideNotice({ notice }) {
  const { t } = useTranslation()
  if (notice.kind === 'unknown') {
    return (
      <div
        role="alert"
        data-testid="category-override-unknown"
        className="rounded-lg bg-warn-soft text-sm text-warn px-4 py-3"
      >
        <div className="flex items-center gap-2 font-medium">
          <IconWarning size={16} />
          {t('override.unknownTitle')}
        </div>
        <p className="mt-1">{t('override.unknownDesc')}</p>
      </div>
    )
  }
  if (notice.kind === 'stale') {
    return (
      <div
        role="alert"
        data-testid="category-override-stale"
        className="rounded-lg bg-warn-soft text-sm text-warn px-4 py-3"
      >
        <div className="flex items-center gap-2 font-medium">
          <IconWarning size={16} />
          {t('override.staleTitle')}
        </div>
        <p className="mt-1">{t('override.staleDesc')}</p>
      </div>
    )
  }
  if (notice.kind === 'unchanged') {
    return (
      <div
        role="alert"
        data-testid="category-override-unchanged"
        className="rounded-lg bg-warn-soft text-sm text-warn px-4 py-3"
      >
        <div className="flex items-center gap-2 font-medium">
          <IconWarning size={16} />
          {t('override.unchangedTitle')}
        </div>
        <p className="mt-1">{t('override.unchangedDesc')}</p>
      </div>
    )
  }
  const key =
    notice.kind === 'notFound'
      ? 'override.errorNotFound'
      : notice.kind === 'forbidden'
        ? 'override.errorForbidden'
        : notice.kind === 'invalid'
          ? 'override.errorInvalid'
          : 'override.errorGeneric'
  return (
    <p role="alert" data-testid="category-override-error" className="text-sm text-danger">
      {t(key)}
    </p>
  )
}

/**
 * The taxonomy row's "Set category" panel. `productKey` addresses the product
 * the flag names (the pair's item side; a taxonomy flag is a self-pair, so it
 * is the entry side too). `assignedCategory`/`rulesCategory` are the card's
 * context — quick choices, not sources of truth. `isAdmin` gates the revert
 * block; `onClose` collapses the surface that opened it.
 */
export function CategoryOverrideForm({
  reviewItemId,
  productKey,
  assignedCategory,
  rulesCategory,
  isAdmin = false,
  onClose,
}) {
  const { t } = useTranslation()
  const reasonId = useId()
  const noticeRef = useRef(null)
  const [draftCategory, setDraftCategory] = useState(null)
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState(null)
  // Focus follows the answer (the rename form's contract): a keyboard user
  // must land on the notice, whose role="alert"/"status" announces it.
  useEffect(() => {
    if (notice) noticeRef.current?.focus()
  }, [notice])

  const identityQuery = useProductIdentity(productKey, { enabled: Boolean(productKey) })
  const bucketsQuery = useTaxonomyBuckets({ enabled: Boolean(productKey) })
  const save = useSetReviewCategory()

  const identity = identityQuery.data
  const product = identity?.product
  const currentCategory = product?.category ?? null
  const busy = save.isPending
  const picked = draftCategory
  // The save is a CHANGE: confirming the assigned category is the ack's job
  // (#626), so a same-value draft stays disabled and the backend's
  // category_unchanged stays a backstop, not a UI state.
  const canSubmit =
    Boolean(product) &&
    Boolean(picked) &&
    picked !== currentCategory &&
    !busy &&
    bucketsQuery.data != null

  // Quick choices first (the PM design's order: assigned category, then the
  // rules head's answer if it differs), then the sealed vocabulary minus the
  // two already offered — deduped, slugs rendered as-is.
  const quick = []
  if (assignedCategory) quick.push(assignedCategory)
  if (rulesCategory && rulesCategory !== assignedCategory) quick.push(rulesCategory)
  const pickerCategories = [
    ...quick,
    ...(bucketsQuery.data?.buckets ?? []).filter((slug) => !quick.includes(slug)),
  ]

  function handleSave() {
    if (!canSubmit || !product) return
    setNotice(null)
    save.mutate(
      {
        id: reviewItemId,
        category: picked,
        productKey,
        version: bucketsQuery.data?.version ?? null,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      {
        // The row's decided state IS the success view; the mutation's settle
        // invalidations re-read the queue. Closing returns the card to the
        // surface that opened it (the rename form's Cancel/Save contract).
        onSuccess: () => onClose?.(),
        onError: (error) => {
          const mapped = noticeFromError(error)
          // The from-value CAS lost: re-read the identity so the provenance
          // line and the disabled-check reflect the category as it is now.
          // The picked slug STAYS — never auto-resubmit (the rename rule).
          if (mapped.kind === 'stale') identityQuery.refetch()
          setNotice(mapped)
        },
      }
    )
  }

  function handleCancel() {
    setDraftCategory(null)
    setReason('')
    setNotice(null)
    onClose?.()
  }

  if (identityQuery.isLoading) {
    return (
      <Panel data-testid="category-override-form">
        <PanelBody>
          <p className="text-sm text-text-muted" aria-busy="true">
            {t('override.loading')}
          </p>
        </PanelBody>
      </Panel>
    )
  }

  if (identityQuery.isError || !product) {
    return (
      <Panel data-testid="category-override-form">
        <PanelBody>
          <p role="alert" className="text-sm text-danger">
            {t('override.loadError')}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => identityQuery.refetch()}>
              {t('override.retry')}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              {t('override.cancel')}
            </Button>
          </div>
        </PanelBody>
      </Panel>
    )
  }

  const provenanceKey =
    product.categorySource === 'human'
      ? 'override.humanSet'
      : product.category
        ? 'override.assignedByPipeline'
        : 'override.noCategory'

  return (
    <Panel data-testid="category-override-form" aria-busy={busy || undefined}>
      <PanelBody>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{t('override.title')}</h3>
          {bucketsQuery.data && <Chip variant="default">{bucketsQuery.data.version}</Chip>}
        </div>

        <p className="mt-3 text-sm">
          <span className="text-text-muted">{t('override.product')}: </span>
          <span className="font-medium" data-testid="category-override-product">
            {product.name}
          </span>
        </p>
        <p className="mt-1 text-sm" data-testid="category-override-current">
          <span className="text-text-muted">{t('override.currentCategory')}: </span>
          <span className="font-medium">{currentCategory ?? t('override.noCategoryValue')}</span>
          <span className="text-text-muted">
            {' '}
            ·{' '}
            {t(provenanceKey, {
              version: product.categoryVersion ?? '—',
              date: product.updatedAt ? new Date(product.updatedAt).toLocaleString() : '',
            })}
          </span>
        </p>
        <p className="mt-2 text-xs text-text-muted">{t('override.frozenPairNote')}</p>

        {notice && (
          <div ref={noticeRef} tabIndex={-1} className="mt-3 outline-none">
            <OverrideNotice notice={notice} />
          </div>
        )}

        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            handleSave()
          }}
        >
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-text-muted">{t('override.pickTitle')}</span>
            {bucketsQuery.isLoading || !bucketsQuery.data ? (
              <p
                className="text-xs text-text-muted"
                aria-busy={bucketsQuery.isLoading || undefined}
              >
                {t('override.vocabularyLoading')}
              </p>
            ) : (
              <CategoryPicker
                categories={pickerCategories}
                value={picked}
                onChange={(next) => {
                  setDraftCategory(next)
                  // A re-pick is a fresh answer about the vocabulary; the old
                  // rejection no longer describes the draft (the rename rule).
                  setNotice(null)
                }}
                resetOption={false}
                labels={{
                  prefix: t('override.pickerPrefix'),
                  all: t('override.pickPlaceholder'),
                  close: t('override.pickerClose'),
                  searchPlaceholder: t('override.pickerSearch'),
                  searchClear: t('override.pickerClear'),
                  noResults: t('override.pickerNoResults'),
                  listboxLabel: t('override.pickerListbox'),
                }}
              />
            )}
            {!picked && <p className="text-xs text-text-muted">{t('override.pickHint')}</p>}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={reasonId} className="text-sm font-medium text-text-muted">
              {t('override.reason')}
            </label>
            <textarea
              id={reasonId}
              value={reason}
              rows={2}
              maxLength={REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t('override.reasonPlaceholder')}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <span className="text-xs text-text-muted tabular-nums">
              {t('override.reasonCount', { count: reason.length })}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {busy ? t('override.submitBusy') : t('override.submit')}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={handleCancel}>
              {t('override.cancel')}
            </Button>
            {busy && (
              <span role="status" className="text-xs text-text-muted">
                {t('override.recording')}
              </span>
            )}
          </div>
        </form>

        {/* The mistake path: an admin who just set the wrong slug compensates
            here without hunting for the product page. The block reads the
            same identity cache the header does. */}
        {isAdmin && (
          <div className="mt-4 border-t border-border pt-3">
            <CategoryRevertBlock
              productKey={productKey}
              isAdmin={isAdmin}
              testId="category-override-revert"
            />
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
