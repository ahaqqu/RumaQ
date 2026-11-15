import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { Chip } from '../components/Chip.jsx'
import { BrochuresGallery } from './BrochuresGallery.jsx'
import { ProductsView } from './ProductsView.jsx'
import { resolvePriceView } from '../lib/pricesHelpers.js'

// Lead copy per catalog view; the Products explorer keeps prices.lead.
const LEAD_KEY_BY_VIEW = {
  brochures: 'prices.brochuresLead',
}

// Products|Brochures shell for /prices (issue #292 PM §3, #293 PM §2).
// The search text and source/category filters live here (not inside
// ProductsView) so they survive a segment switch.
//
// #673: /prices is the end-user browse surface — the Products explorer plus
// the brochure gallery. Promos and every admin/QA tool (brochure ingestion
// QA, rename, alias candidates) live on /admin/catalog; this page never
// renders them, whatever me.user.isAdmin says. There is no legacy ?view=
// handling: retired values are dropped by validateSearch and the resolver
// falls back to Products.
export function Prices() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const [search, setSearch] = useState('')
  const [source, setSource] = useState(null)
  const [category, setCategory] = useState(null)

  // ?view=brochures selects the gallery; a #productKey hash is the stronger
  // intent and forces the Products view regardless of the param (PM AC 7 /
  // #293 AC 5) — one shared resolver (lib/pricesHelpers.js).
  const { view } = useSearch({ strict: false })
  const activeView = resolvePriceView(view, location.hash)

  const selectView = (next) => {
    navigate({ to: '/prices', search: next === 'products' ? {} : { view: next }, hash: '' })
  }

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">
          {activeView === 'products' ? t('prices.lead') : t(LEAD_KEY_BY_VIEW[activeView])}
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
          pressed={activeView === 'brochures'}
          onClick={() => selectView('brochures')}
        >
          {t('prices.viewBrochures')}
        </Chip>
      </div>

      {activeView === 'products' ? (
        <ProductsView
          search={search}
          setSearch={setSearch}
          source={source}
          setSource={setSource}
          category={category}
          setCategory={setCategory}
        />
      ) : (
        <BrochuresGallery />
      )}
    </>
  )
}
