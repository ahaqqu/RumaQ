import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../lib/api'
import { useProductIdentity, useRevertProductCategory } from '../lib/queries/products.js'
import { Button } from './Button.jsx'
import { IconCheck, IconWarning } from './icons.jsx'

// The category revert affordance (ahaqqu/RumaQ#728), shared across its two
// surfaces exactly like the rename revert rides ProductRenameForm: the
// review row's CategoryOverrideForm renders it under the picker, and the
// product detail surface (the revert's home base) renders it standalone. The
// route stays product-addressed (`DELETE /api/admin/products/:productKey/
// category`); only the button is shared — the reconciled design's PM-over-
// architect note, adopted by the manager.
//
// The SET affordance deliberately does NOT live here: the owner decision
// keeps the picker on the review tab only, so the product surface gets the
// revert (a compensation for something that already happened) but no drive-by
// category editor.
//
// One component, own identity read: TanStack dedupes the shared
// product-identity cache key, so a mount inside the open override form and
// any standalone mount read the same fetch. The revertable derivation is the
// linear-history rule — only the LATEST receipt, only an unreverted 'set'
// whose new_category still IS the live category (NULL-safe: an override onto
// an uncategorized product is revertable back to no category). The server
// re-checks all of it behind the expectedMetadataVersion CAS; a stale client
// answer costs a 409 stale_revert, never a wrong write.
//
// No server string is ever rendered (the Household error-vocabulary
// precedent): statuses map to inline copy.

function noticeFromError(error) {
  const status = error instanceof ApiError ? error.status : undefined
  const body = error instanceof ApiError ? error.body : undefined
  const code = body && typeof body === 'object' ? body.error : undefined
  if (status === 409 && code === 'stale_revert') return { kind: 'revertStale' }
  if (status === 409 && code === 'stale_product') return { kind: 'stale' }
  if (status === 404) return { kind: 'notFound' }
  if (status === 403) return { kind: 'forbidden' }
  return { kind: 'error' }
}

function RevertNotice({ notice }) {
  const { t } = useTranslation()
  if (notice.kind === 'revertSuccess') {
    return (
      <div
        role="status"
        data-testid="category-revert-success"
        className="mt-2 rounded-lg bg-ok-soft text-sm text-text px-3 py-2"
      >
        <div className="flex items-center gap-2 font-medium text-ok">
          <IconCheck size={16} />
          {t('override.revertSuccessTitle')}
        </div>
        <p className="mt-1">
          {t('override.revertSuccessBody', {
            category: notice.category,
            version: notice.indexVersion ?? '—',
          })}
        </p>
      </div>
    )
  }
  if (notice.kind === 'revertStale' || notice.kind === 'stale') {
    return (
      <div
        role="alert"
        data-testid="category-revert-stale"
        className="mt-2 rounded-lg bg-warn-soft text-sm text-warn px-3 py-2"
      >
        <div className="flex items-center gap-2 font-medium">
          <IconWarning size={16} />
          {t(notice.kind === 'revertStale' ? 'override.revertStaleTitle' : 'override.staleTitle')}
        </div>
        <p className="mt-1">
          {t(notice.kind === 'revertStale' ? 'override.revertStaleDesc' : 'override.staleDesc')}
        </p>
      </div>
    )
  }
  const key =
    notice.kind === 'notFound'
      ? 'override.errorNotFound'
      : notice.kind === 'forbidden'
        ? 'override.errorForbidden'
        : 'override.errorGeneric'
  return (
    <p role="alert" data-testid="category-revert-error" className="mt-2 text-sm text-danger">
      {t(key)}
    </p>
  )
}

/**
 * The current category, its provenance, and — for an admin — the revert
 * action when the latest override is still compensable. `isAdmin` gates the
 * button only: the provenance line renders for anyone who could read the
 * identity. The block hides entirely when the identity read fails (the
 * parent panel owns its own load-error UI for that case).
 */
export function CategoryRevertBlock({ productKey, isAdmin = false, testId }) {
  const { t } = useTranslation()
  const [notice, setNotice] = useState(null)
  const identityQuery = useProductIdentity(productKey, { enabled: Boolean(productKey) })
  const revert = useRevertProductCategory()
  const identity = identityQuery.data
  const product = identity?.product
  const latestSet = identity?.categoryAudit?.[0] ?? null
  const revertable =
    isAdmin &&
    product &&
    latestSet?.action === 'set' &&
    latestSet.metadataVersionAfter === product.metadataVersion &&
    latestSet.newCategory === product.category
      ? latestSet
      : null

  if (identityQuery.isLoading) {
    return (
      <div data-testid={testId ?? 'category-revert-block'} aria-busy="true">
        <p className="text-sm text-text-muted">{t('override.loading')}</p>
      </div>
    )
  }
  if (identityQuery.isError || !product) return null

  const provenanceKey =
    product.categorySource === 'human'
      ? 'override.humanSet'
      : product.category
        ? 'override.assignedByPipeline'
        : 'override.noCategory'

  function handleRevert() {
    if (!revertable || revert.isPending) return
    const restoreTo = revertable.oldCategory ?? t('override.noCategoryValue')
    if (!window.confirm(t('override.revertConfirm', { category: restoreTo }))) return
    setNotice(null)
    revert.mutate(
      {
        productKey,
        expectedMetadataVersion: product.metadataVersion,
      },
      {
        onSuccess: (result) => {
          // The seeded identity re-render swaps the provenance line; the
          // notice names what the catalog holds now (a revert-to-uncategorized
          // restores null — the no-category copy, not an empty string).
          const restored = result?.product?.category ?? null
          setNotice({
            kind: 'revertSuccess',
            category: restored ?? t('override.noCategoryValue'),
            indexVersion: result?.indexVersion,
          })
        },
        onError: (error) => {
          setNotice(noticeFromError(error))
        },
      }
    )
  }

  return (
    <div data-testid={testId ?? 'category-revert-block'} aria-busy={revert.isPending || undefined}>
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wide">
        {t('override.currentCategoryTitle')}
      </div>
      <p className="mt-1 text-sm" data-testid="category-revert-provenance">
        <span className="font-medium">{product.category ?? t('override.noCategoryValue')}</span>
        <span className="text-text-muted">
          {' '}
          ·{' '}
          {t(provenanceKey, {
            version: product.categoryVersion ?? '—',
            date: product.updatedAt ? new Date(product.updatedAt).toLocaleString() : '',
          })}
        </span>
      </p>
      {revertable && (
        <div className="mt-2">
          <p className="text-sm">
            {t('override.revertLatest', {
              oldCategory: revertable.oldCategory ?? t('override.noCategoryValue'),
              newCategory: revertable.newCategory,
            })}
          </p>
          <Button
            variant="danger"
            size="sm"
            className="mt-2"
            disabled={revert.isPending}
            onClick={handleRevert}
          >
            {revert.isPending ? t('override.revertBusy') : t('override.revertAction')}
          </Button>
        </div>
      )}
      {notice && <RevertNotice notice={notice} />}
    </div>
  )
}
