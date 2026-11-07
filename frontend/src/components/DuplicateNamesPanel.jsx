import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDuplicateProductNames } from '../lib/queries/products.js'
import { Panel, PanelBody } from './Panel.jsx'
import { Button } from './Button.jsx'
import { Chip } from './Chip.jsx'
import { IconWarning } from './icons.jsx'

// Read-only duplicate-name report (ahaqqu/RumaQ#485). A rename racing an
// ingest, or a rename inside the pipeline's ≤48 h cached-index window, can
// leave two canonical products sharing a name — there is deliberately no
// UNIQUE index to stop it (legacy names, merges are a non-goal). This panel
// surfaces those collisions for an admin and does nothing else: it never
// merges, renames, or writes.
//
// Lazy: the report is fetched only when the admin opens it (the rename form's
// pattern), so the products page pays nothing for a collapsed panel.

const STATUS_KEY = {
  canonical: 'rename.statusCanonical',
  provisional: 'rename.statusProvisional',
  needs_review: 'rename.statusNeedsReview',
}

// Same local date-formatting pattern as the other admin pages (AdminReview,
// Household): a short absolute day, not a relative age.
function formatDate(value, language) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleDateString(language, { day: 'numeric', month: 'short', year: 'numeric' })
}

function ProductRow({ product, displayName, language }) {
  const { t } = useTranslation()
  const updated = formatDate(product.updatedAt, language)
  return (
    <li
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
      data-testid="duplicate-name-product"
    >
      <span className="font-mono text-xs break-all">{product.productKey}</span>
      {product.name !== displayName && <span className="text-text-muted">{product.name}</span>}
      <Chip variant="default">{t(STATUS_KEY[product.status] ?? 'rename.statusProvisional')}</Chip>
      <span className="text-xs text-text-muted">
        {product.stores.length > 0 ? product.stores.join(', ') : t('duplicates.noStores')}
      </span>
      {updated && (
        <span className="text-xs text-text-muted">
          {t('duplicates.updated', { date: updated })}
        </span>
      )}
    </li>
  )
}

export function DuplicateNamesPanel() {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const report = useDuplicateProductNames({ enabled: open })

  const groups = report.data?.groups ?? []
  const truncated = report.data?.truncated === true

  return (
    <Panel className="mb-4" data-testid="duplicate-names-panel">
      <PanelBody>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-semibold">{t('duplicates.title')}</h2>
            <p className="mt-0.5 text-xs text-text-muted">{t('duplicates.desc')}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t('duplicates.hide') : t('duplicates.show')}
          </Button>
        </div>

        {open && (
          <div id={bodyId} className="mt-3">
            {report.isLoading ? (
              <p className="text-sm text-text-muted" aria-busy="true">
                {t('duplicates.loading')}
              </p>
            ) : report.isError ? (
              <div>
                <p role="alert" className="text-sm text-danger">
                  {t('duplicates.error')}
                </p>
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => report.refetch()}>
                  {t('duplicates.retry')}
                </Button>
              </div>
            ) : groups.length === 0 ? (
              <p className="text-sm text-text-muted" data-testid="duplicate-names-empty">
                {t('duplicates.empty')}
              </p>
            ) : (
              <>
                {truncated && (
                  <p className="mb-2 text-xs text-warn" data-testid="duplicate-names-truncated">
                    <IconWarning size={12} /> {t('duplicates.truncated')}
                  </p>
                )}
                <ul className="flex flex-col gap-3" data-testid="duplicate-names-groups">
                  {groups.map((group) => (
                    <li key={group.normalizedName}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{group.displayName}</span>
                        <span className="text-xs text-text-muted">
                          {t('duplicates.productCount', { count: group.productCount })}
                        </span>
                      </div>
                      <ul className="mt-1 flex flex-col gap-1">
                        {group.products.map((product) => (
                          <ProductRow
                            key={product.productKey}
                            product={product}
                            displayName={group.displayName}
                            language={i18n.language}
                          />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
