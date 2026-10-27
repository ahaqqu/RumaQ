import { useState, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LocChip, TimeSignal, EmptyState, SkeletonRows } from '../components/ui.jsx'
import { useStock, useUpdateStock, useLocations } from '../lib/queries/index.js'
import { usePersona } from '../context/PersonaContext.jsx'
import { personaText } from '../lib/persona.js'
import { IconSearch, IconBox, IconPlus, IconMinus } from '../components/icons.jsx'
import { cn } from '../lib/cn.js'
import { Panel } from '../components/Panel.jsx'

function getDaysUntil(expiryDate) {
  if (!expiryDate) return null
  const now = new Date()
  const expiry = new Date(expiryDate + 'T00:00:00')
  return Math.round((expiry - now) / 86400000)
}

export function Inventory() {
  const { t } = useTranslation()
  const { persona } = usePersona()
  const [q, setQ] = useState('')
  const [loc, setLoc] = useState('all')
  const searchTimer = useRef(null)
  const [debouncedQ, setDebouncedQ] = useState('')

  const { data: stockData, isLoading } = useStock({
    location: loc === 'all' ? undefined : loc,
    q: debouncedQ || undefined,
  })
  const { data: locationsData } = useLocations()
  const updateStock = useUpdateStock()

  const rows = stockData?.stock ?? []
  const locations = useMemo(() => locationsData?.locations ?? [], [locationsData])

  const handleSearch = useCallback((value) => {
    setQ(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setDebouncedQ(value)
    }, 300)
  }, [])

  const handleQtyUpdate = useCallback(
    (id, delta) => {
      const item = rows.find((r) => r.id === id)
      if (!item) return
      const newQty = Math.max(0, item.qty + delta)
      updateStock.mutate({ id, payload: { qty: newQty } })
    },
    [rows, updateStock]
  )

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">
          {personaText('inventoryLead', persona, t)}
        </p>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <IconSearch
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint"
          />
          <input
            value={q}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={t('inventory.searchPlaceholder')}
            aria-label={t('inventory.searchAriaLabel')}
            className="pl-10"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-5">
        <button
          className={cn(
            'inline-flex items-center gap-2 rounded-pill text-xs font-medium px-3 py-1 min-h-9 px-4 py-2 text-sm bg-surface-raised border border-border-strong text-text-muted hover:bg-surface-sunken select-none',
            loc === 'all' && 'bg-accent-soft border-accent-soft-border text-accent-hover'
          )}
          aria-pressed={loc === 'all'}
          onClick={() => setLoc('all')}
        >
          {t('inventory.all')}
        </button>
        {locations.map((locItem) => (
          <button
            key={locItem.id}
            className={cn(
              'inline-flex items-center gap-2 rounded-pill text-xs font-medium px-3 py-1 min-h-9 px-4 py-2 text-sm bg-surface-raised border border-border-strong text-text-muted hover:bg-surface-sunken select-none',
              loc === locItem.id && 'bg-accent-soft border-accent-soft-border text-accent-hover'
            )}
            aria-pressed={loc === locItem.id}
            onClick={() => setLoc(locItem.id)}
          >
            {locItem.label}
          </button>
        ))}
      </div>

      <Panel>
        {isLoading ? (
          <SkeletonRows n={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={IconBox}
            title={t('inventory.noMatch')}
            desc={t('inventory.noMatchDesc')}
          />
        ) : (
          <div className="flex flex-col">
            {rows.map((s) => (
              <div
                className="grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4 border-b border-border last:border-b-0 hover:bg-surface-sunken transition-colors"
                key={s.id}
                data-testid="stock-row"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-sm flex items-center gap-3 flex-wrap">
                    {s.name} <LocChip loc={s.location} />
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-sm text-text-muted flex-wrap">
                    <TimeSignal
                      expiryDays={getDaysUntil(s.expiry_date)}
                      runOut={s.run_out_days}
                      basis={s.basis}
                    />
                  </div>
                </div>
                <div className="text-right flex flex-col items-end gap-1">
                  <div className="flex items-center gap-2">
                    <button
                      className="w-7 h-7 rounded-md inline-flex items-center justify-center text-text-muted hover:bg-surface-sunken hover:text-text disabled:opacity-50"
                      onClick={() => handleQtyUpdate(s.id, -1)}
                      disabled={s.qty <= 0}
                      aria-label={t('inventory.decreaseQty')}
                    >
                      <IconMinus size={14} />
                    </button>
                    <span className="font-semibold min-w-[3ch] text-center" data-testid="stock-qty">
                      {s.qty} {s.unit}
                    </span>
                    <button
                      className="w-7 h-7 rounded-md inline-flex items-center justify-center text-text-muted hover:bg-surface-sunken hover:text-text"
                      onClick={() => handleQtyUpdate(s.id, 1)}
                      aria-label={t('inventory.increaseQty')}
                    >
                      <IconPlus size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  )
}
