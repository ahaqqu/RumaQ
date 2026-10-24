import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRp } from '../data/mock.js'
import { usePersona } from '../context/PersonaContext.jsx'
import { personaText } from '../lib/persona.js'
import { IconSpark } from '../components/icons.jsx'
import { useHistory, usePurchasePatterns, useStores } from '../lib/queries/index.js'
import { getReceiptUrl } from '../lib/api'
import { Button } from '../components/Button.jsx'
import { Panel } from '../components/Panel.jsx'

export function History({ askAssistant }) {
  const { t } = useTranslation()
  const { persona } = usePersona()
  const monthNames = t('history.months', { returnObjects: true })

  const [store, setStore] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(null)
  const [lightbox, setLightbox] = useState(null)

  const filters = {
    store: store || undefined,
    from: from || undefined,
    to: to || undefined,
    q: q || undefined,
  }

  const history = useHistory({ ...filters, cursor })
  const patterns = usePurchasePatterns()
  const stores = useStores()

  const purchases = history.data?.purchases ?? []
  const monthTotals = history.data?.month_totals ?? []
  const avgPerMonth = history.data?.avg_per_month ?? 0
  const nextCursor = history.data?.next_cursor ?? null
  const patternItems = patterns.data?.patterns ?? []
  const storeOptions = stores.data?.stores ?? []

  const groups = useMemo(() => {
    const map = new Map()
    for (const p of purchases) {
      const m = String(p.date).slice(0, 7)
      const g = map.get(m) ?? { month: m, rows: [], total: 0 }
      g.rows.push(p)
      g.total += p.total || 0
      map.set(m, g)
    }
    return Array.from(map.values())
  }, [purchases])

  const monthLabel = (m) => {
    const [y, mo] = m.split('-')
    return `${monthNames[Number(mo)]} ${y}`
  }
  const fmtDate = (d) => {
    const [, m, day] = d.split('-')
    return `${Number(day)} ${monthNames[Number(m)]}`
  }

  const applyFilters = () => setCursor(null)

  const loadMore = () => {
    if (nextCursor) setCursor(nextCursor)
  }

  const totalSpend = monthTotals.reduce((s, m) => s + (m.total || 0), 0)

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">
          {personaText('historyLead', persona, t)}
        </p>
      </div>

      <Panel className="p-4">
        <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
          <input
            type="search"
            placeholder={t('history.searchPlaceholder')}
            aria-label={t('history.searchPlaceholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              applyFilters()
            }}
          />
          <select
            value={store}
            onChange={(e) => {
              setStore(e.target.value)
              applyFilters()
            }}
            aria-label={t('history.filterStore')}
          >
            <option value="">{t('history.filterAll')}</option>
            {storeOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={from}
            aria-label={t('history.filterFrom')}
            onChange={(e) => {
              setFrom(e.target.value)
              applyFilters()
            }}
          />
          <input
            type="date"
            value={to}
            aria-label={t('history.filterTo')}
            onChange={(e) => {
              setTo(e.target.value)
              applyFilters()
            }}
          />
        </div>
      </Panel>

      {history.isLoading && <Panel className="p-5 text-center">{t('history.loading')}</Panel>}

      {history.isError && !history.isLoading && (
        <Panel className="p-5 text-center text-text-muted">{t('history.error')}</Panel>
      )}

      {!history.isLoading && !history.isError && purchases.length === 0 && (
        <Panel className="p-5 text-center">
          <div className="font-semibold text-text text-sm">{t('history.empty')}</div>
          <div className="text-sm text-text-muted mt-2">{t('history.emptyDesc')}</div>
        </Panel>
      )}

      {!history.isLoading && !history.isError && purchases.length > 0 && (
        <>
          <Panel className="p-4 flex flex-wrap gap-4 text-text-muted text-sm">
            <div>
              <strong>{t('history.total')}</strong> {formatRp(totalSpend)}
            </div>
            <div>
              <strong>{t('history.avgPerMonth')}</strong> {formatRp(avgPerMonth)}
            </div>
          </Panel>

          <Panel className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="text-left font-medium text-text-muted px-4 py-3 border-b border-border text-xs uppercase tracking-wide">
                    {t('history.date')}
                  </th>
                  <th className="text-left font-medium text-text-muted px-4 py-3 border-b border-border text-xs uppercase tracking-wide">
                    {t('history.item')}
                  </th>
                  <th className="text-left font-medium text-text-muted px-4 py-3 border-b border-border text-xs uppercase tracking-wide">
                    {t('history.store')}
                  </th>
                  <th className="text-right font-medium text-text-muted px-4 py-3 border-b border-border text-xs uppercase tracking-wide tabular-nums">
                    {t('history.price')}
                  </th>
                  <th className="text-left font-medium text-text-muted px-4 py-3 border-b border-border text-xs uppercase tracking-wide">
                    {t('history.receipt')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Group
                    key={g.month}
                    g={g}
                    monthLabel={monthLabel}
                    fmtDate={fmtDate}
                    t={t}
                    formatRp={formatRp}
                    onReceiptClick={setLightbox}
                  />
                ))}
              </tbody>
            </table>
          </Panel>

          {nextCursor && (
            <div className="text-center mt-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={loadMore}
                disabled={history.isFetching}
              >
                {history.isFetching ? t('history.loading') : t('history.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}

      {patternItems.length > 0 && (
        <section className="mt-8">
          <Panel className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-accent">
                <IconSpark size={18} />
              </span>
              <strong>{t('history.patternsTitle')}</strong>
            </div>
            <ul className="grid gap-2">
              {patternItems.slice(0, 5).map((p) => (
                <li key={p.item_id} className="flex items-center justify-between gap-3">
                  <span>{p.name}</span>
                  <span className="text-text-muted text-sm">
                    {t('history.patternSummary', {
                      name: '',
                      pattern:
                        p.avg_interval_days != null
                          ? t('history.patternEvery', {
                              n: p.avg_interval_days,
                              count: p.avg_interval_days,
                            })
                          : t('history.patternRecently'),
                      qty: p.avg_qty,
                    }).trim()}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Button variant="ghost" size="sm" onClick={askAssistant}>
                {t('history.makePlan')}
              </Button>
            </div>
          </Panel>
        </section>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-text/32 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label={t('history.receipt')}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]">
            <img
              src={getReceiptUrl(lightbox)}
              alt={t('history.receipt')}
              className="max-w-[90vw] max-h-[90vh] object-contain"
            />
            <Button
              size="sm"
              variant="secondary"
              className="absolute top-2 right-2"
              onClick={() => setLightbox(null)}
              aria-label={t('history.closeReceipt')}
            >
              {t('history.closeReceipt')}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

function Group({ g, monthLabel, fmtDate, t, formatRp, onReceiptClick }) {
  return (
    <>
      <tr className="bg-surface-sunken">
        <td
          colSpan={5}
          className="px-4 py-3 font-semibold text-text-muted text-xs uppercase tracking-wide"
        >
          {monthLabel(g.month)} · {t('history.purchases_count', { count: g.rows.length })} ·{' '}
          {t('history.total')} {formatRp(g.total)}
        </td>
      </tr>
      {g.rows.map((p, _i) =>
        p.items.map((it, j) => (
          <tr key={p.id + it.id + j}>
            {j === 0 ? (
              <td
                className="px-4 py-3 border-b border-border whitespace-nowrap"
                rowSpan={p.items.length}
              >
                {fmtDate(p.date)}
              </td>
            ) : null}
            <td className="px-4 py-3 border-b border-border">
              {it.name || '—'}{' '}
              <span className="text-text-muted">
                · {it.qty}
                {it.unit ? ` ${it.unit}` : ''}
              </span>
            </td>
            <td className="px-4 py-3 border-b border-border">{p.store_label || '—'}</td>
            <td className="px-4 py-3 border-b border-border text-right tabular-nums">
              {it.price != null
                ? formatRp(it.price)
                : j === p.items.length - 1
                  ? formatRp(p.total)
                  : ''}
            </td>
            <td className="px-4 py-3 border-b border-border">
              {j === 0 && p.has_receipt ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onReceiptClick(p.id)}
                  aria-label={t('history.receipt')}
                >
                  {t('history.receipt')}
                </Button>
              ) : null}
            </td>
          </tr>
        ))
      )}
    </>
  )
}
