import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAliasCandidateCounts, useBulkApproveExactAliases } from '../lib/queries/products.js'
import { Panel, PanelBody } from './Panel.jsx'
import { Button } from './Button.jsx'

// Bulk exact-name alias approval (ahaqqu/RumaQ#515, follow-up to #489).
// Candidate aliases are the raw store spellings the pipeline saw; the majority
// are just the canonical wording in another case, and deciding them one row at
// a time in the rename form means hundreds of clicks for the safe ones. This
// panel offers exactly one action: approve the candidates whose name equals
// their own product's canonical name case-insensitively. Everything else —
// whitespace, size, and wording variants — stays a manual decision, which is
// why the confirm names the count and the backend never widens the match.
//
// Read-only until the button is clicked: the counts are one catalog-wide admin
// read (no write, no index bump), and the action itself is idempotent, so a
// retry after an error continues instead of double-approving.

export function AliasCandidatesPanel() {
  const { t } = useTranslation()
  const counts = useAliasCandidateCounts()
  const bulk = useBulkApproveExactAliases()
  const [notice, setNotice] = useState(null)
  const [failure, setFailure] = useState(null)

  const candidateTotal = counts.data?.candidates ?? 0
  const exactTotal = counts.data?.exactCandidates ?? 0
  const busy = bulk.isPending
  const disabled = busy || counts.isLoading || counts.isError || exactTotal === 0
  // A failed chunk still committed the earlier ones; the route's 500 body says
  // how many, so the panel can be honest instead of implying nothing changed.
  const partiallyApproved = Number(failure?.body?.approved ?? 0)

  const approve = () => {
    if (disabled) return
    // The backend approves only exact matches, but the count is what the admin
    // is agreeing to — the confirm has to name it, not just say "approve".
    if (!window.confirm(t('aliasBulk.confirm', { count: exactTotal }))) return
    setNotice(null)
    setFailure(null)
    bulk.mutate(undefined, {
      onSuccess: (result) => setNotice(result),
      onError: (error) => setFailure(error),
    })
  }

  return (
    <Panel className="mb-4" data-testid="alias-candidates-panel">
      <PanelBody>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-semibold">{t('aliasBulk.title')}</h2>
            <p className="mt-0.5 text-xs text-text-muted">{t('aliasBulk.desc')}</p>
          </div>
          <Button
            size="sm"
            onClick={approve}
            disabled={disabled}
            aria-busy={busy}
            data-testid="alias-bulk-approve"
          >
            {busy ? t('aliasBulk.approving') : t('aliasBulk.approve')}
          </Button>
        </div>

        {counts.isLoading ? (
          <p className="mt-3 text-sm text-text-muted" aria-busy="true">
            {t('aliasBulk.loading')}
          </p>
        ) : counts.isError ? (
          <div className="mt-3">
            <p role="alert" className="text-sm text-danger">
              {t('aliasBulk.error')}
            </p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => counts.refetch()}>
              {t('aliasBulk.retry')}
            </Button>
          </div>
        ) : (
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <div className="flex items-baseline gap-2">
              <dt className="text-text-muted">{t('aliasBulk.candidateTotal')}</dt>
              <dd className="font-medium" data-testid="alias-candidate-total">
                {candidateTotal}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-text-muted">{t('aliasBulk.exactTotal')}</dt>
              <dd className="font-medium" data-testid="alias-candidate-exact">
                {exactTotal}
              </dd>
            </div>
          </dl>
        )}

        {notice && (
          <p role="status" data-testid="alias-bulk-success" className="mt-3 text-sm text-ok">
            {notice.approved === 0
              ? t('aliasBulk.nothingToApprove')
              : t('aliasBulk.success', { count: notice.approved })}{' '}
            <span className="text-text-muted">
              {t('aliasBulk.indexVersion')}{' '}
              <span className="font-medium" data-testid="alias-bulk-index-version">
                {notice.indexVersion}
              </span>
            </span>
          </p>
        )}

        {failure && (
          <p role="alert" data-testid="alias-bulk-error" className="mt-3 text-sm text-danger">
            {partiallyApproved > 0
              ? t('aliasBulk.approveErrorPartial', { approved: partiallyApproved })
              : t('aliasBulk.approveError')}
          </p>
        )}
      </PanelBody>
    </Panel>
  )
}
