import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { Chip } from '../components/Chip.jsx'
import { ProductsView } from './ProductsView.jsx'
import { PromosView } from './PromosView.jsx'
import { BrochuresView } from './BrochuresView.jsx'

// Products|Promos|Brochures shell for /prices (issue #292 PM §3, #293 PM §2).
// The search text and source filter live here (not inside ProductsView) so
// the promo/brochure views' example jump can clear them — a jump is a fresh
// browse context that must land inside the unfiltered 200.
export function Prices() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const [search, setSearch] = useState('')
  const [source, setSource] = useState(null)

  // ?view=promos|brochures selects a catalog view; a #productKey hash is the
  // stronger intent and forces the Products view regardless of the param
  // (PM AC 7 / #293 AC 5).
  const { view } = useSearch({ strict: false })
  const activeView =
    view === 'promos' && !location.hash
      ? 'promos'
      : view === 'brochures' && !location.hash
        ? 'brochures'
        : 'products'

  const selectView = (next) => {
    navigate({ to: '/prices', search: next === 'products' ? {} : { view: next }, hash: '' })
  }

  // Example-product jump (PM AC 6): clear the local search/source filters —
  // guaranteeing the target is inside the unfiltered 200 — then navigate to
  // the #productKey deep link; ProductsView's hash-apply effect expands and
  // scrolls. Dropping the view param activates the Products view.
  const jump = (productKey) => {
    setSearch('')
    setSource(null)
    navigate({ to: '/prices', search: {}, hash: productKey, replace: false })
  }

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">
          {activeView === 'promos'
            ? t('prices.promosLead')
            : activeView === 'brochures'
              ? t('prices.brochuresLead')
              : t('prices.lead')}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 mb-5" data-testid="prices-view-segments">
        <Chip
          variant="filter"
          pressed={activeView === 'products'}
          onClick={() => selectView('products')}
        >
          {t('prices.viewProducts')}
        </Chip>
        <Chip
          variant="filter"
          pressed={activeView === 'promos'}
          onClick={() => selectView('promos')}
        >
          {t('prices.viewPromos')}
        </Chip>
        <Chip
          variant="filter"
          pressed={activeView === 'brochures'}
          onClick={() => selectView('brochures')}
        >
          {t('prices.viewBrochures')}
        </Chip>
      </div>

      {activeView === 'products' ? (
        <ProductsView search={search} setSearch={setSearch} source={source} setSource={setSource} />
      ) : activeView === 'promos' ? (
        <PromosView onJump={jump} />
      ) : (
        <BrochuresView onJump={jump} />
      )}
    </>
  )
}
