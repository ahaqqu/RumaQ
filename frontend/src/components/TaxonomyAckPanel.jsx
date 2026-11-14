import { useTranslation } from 'react-i18next'
import { useAcknowledgeTaxonomy } from '../lib/queries/review.js'
import { Button } from './Button.jsx'

// #626: the taxonomy page's bulk action — the taxonomy page is a
// category-quality surface, not an identity question, and the bulk
// acknowledgement is the honest decision available (no category-edit path
// yet). One confirm, one server round trip, per-row undo afterwards: the
// confirm names the number and the undo shape honestly — the backend has no
// bulk undo, only per-row.
export function TaxonomyAckPanel({ pendingCount }) {
  const { t } = useTranslation()
  const acknowledge = useAcknowledgeTaxonomy()

  function handleAcknowledge() {
    if (acknowledge.isPending) return
    if (!window.confirm(t('review.taxonomyAckConfirm', { count: pendingCount }))) {
      return
    }
    acknowledge.mutate()
  }

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface-raised px-4 py-3">
      <p className="text-xs leading-snug text-text-muted">{t('review.taxonomyLead')}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {pendingCount > 0 && (
          <Button
            variant="secondary"
            size="sm"
            disabled={acknowledge.isPending}
            onClick={handleAcknowledge}
          >
            {t('review.taxonomyAck', { count: pendingCount })}
          </Button>
        )}
        {acknowledge.isPending && (
          <span role="status" className="text-xs text-text-muted">
            {t('review.taxonomyAckWorking')}
          </span>
        )}
        {acknowledge.isSuccess && acknowledge.data?.acknowledged != null && (
          <span role="status" className="text-xs text-text-muted">
            {t('review.taxonomyAckDone', { count: acknowledge.data.acknowledged })}
          </span>
        )}
        {acknowledge.isError && (
          <span className="text-xs text-danger" role="alert">
            {t('review.taxonomyAckFailed')}
          </span>
        )}
      </div>
    </div>
  )
}
