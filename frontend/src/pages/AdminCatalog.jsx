import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { useMe } from '../lib/queries/me.js'
import { EmptyState } from '../components/ui.jsx'
import { Panel } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { ProductsView } from './ProductsView.jsx'
import { BrochuresView } from './BrochuresView.jsx'
import { PromosView } from './PromosView.jsx'
import { PromosReview } from './PromosReview.jsx'
import { resolveCatalogTab } from '../lib/pricesHelpers.js'
import { IconWarning } from '../components/icons.jsx'

// Lead copy per catalog tab; the Products home keeps catalog.lead. The promos
// tab switches its lead with the sub-view below (issue #717).
const LEAD_KEY_BY_TAB = {
  'brochures-qa': 'catalog.brochuresQaLead',
}
const PROMOS_LEAD_BY_VIEW = {
  review: 'catalog.promosReviewLead',
  catalog: 'prices.promosLead',
}

// The admin catalog (issue #673): the home of the admin/QA tools that used to
// be mixed into the end-user /prices explorer. Three sections:
//
// - Products — the product lookup/search + expanded detail (rename for
//   admins) plus the duplicate-names report and alias-candidates action,
//   reusing ProductsView with adminTools. A #productKey deep link opens this
//   section and expands/scrolls the product (ProductsView owns that effect).
// - Brochures QA — the #630 ingestion-QA browser: store/date filters and a
//   multi-column brochure grid. Since #716 a card opens the chrome-less
//   viewer in a NEW tab with ?admin=true, where every product and its full
//   ingestion metadata render in the QA items table (the former in-place
//   review moved there). The user-facing /prices gallery renders none of
//   these QA fields.
// - Promos — two sub-views (#717): Review (the default) lists every current
//   promo-evidence observation per item with its VERBATIM scraped chips so
//   the owner can review whether promos are captured correctly and decide
//   how each chip class should be handled; Catalog is the promo catalog
//   moved off /prices in #673 (fixed group order, per-source badges,
//   expandable ≤5 examples). Clicking a catalog example jumps to
//   /prices#productKey: the explorer is every household user's surface
//   (admins included), and the fresh /prices mount guarantees the unfiltered
//   landing context while ProductsView's hash-apply effect expands the
//   product.
//
// ?tab= selects the section; the retired ?tab=brochures value is not
// recognized — validateSearch drops it and the page lands on Products (hard
// removal, no redirects). The route guard is the same client-side pattern as
// AdminPrices/AdminReview/AdminScrape (useMe + unauthorized state); the APIs
// behind every tool are already requireAdmin.
export function AdminCatalog() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { data: me } = useMe()
  const isAdmin = me?.user?.isAdmin === true

  const { tab } = useSearch({ strict: false })
  const activeTab = resolveCatalogTab(tab, location.hash)

  // Search text and the source/category filters live here (not inside
  // ProductsView) so they survive a tab switch. The promos sub-view is local
  // state: Review is the owner's ask (#717), Catalog stays reachable.
  const [search, setSearch] = useState('')
  const [source, setSource] = useState(null)
  const [category, setCategory] = useState(null)
  const [promosView, setPromosView] = useState('review')

  if (!isAdmin) {
    return (
      <Panel>
        <EmptyState
          icon={IconWarning}
          title={t('catalog.forbidden')}
          desc={t('catalog.forbiddenDesc')}
        />
      </Panel>
    )
  }

  const selectTab = (next) => {
    navigate({ to: '/admin/catalog', search: next === 'products' ? {} : { tab: next }, hash: '' })
  }

  const leadKey =
    activeTab === 'products'
      ? 'catalog.lead'
      : activeTab === 'promos'
        ? PROMOS_LEAD_BY_VIEW[promosView]
        : LEAD_KEY_BY_TAB[activeTab]

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">{t(leadKey)}</p>
      </div>

      <div
        className="flex flex-wrap gap-2 mb-5"
        role="group"
        aria-label={t('catalog.tabsLabel')}
        data-testid="catalog-tabs"
      >
        <Chip
          variant="filter"
          pressed={activeTab === 'products'}
          onClick={() => selectTab('products')}
        >
          {t('catalog.tabProducts')}
        </Chip>
        <Chip
          variant="filter"
          pressed={activeTab === 'brochures-qa'}
          onClick={() => selectTab('brochures-qa')}
        >
          {t('catalog.tabBrochuresQa')}
        </Chip>
        <Chip variant="filter" pressed={activeTab === 'promos'} onClick={() => selectTab('promos')}>
          {t('catalog.tabPromos')}
        </Chip>
      </div>

      {activeTab === 'products' ? (
        <ProductsView
          search={search}
          setSearch={setSearch}
          source={source}
          setSource={setSource}
          category={category}
          setCategory={setCategory}
          adminTools
          basePath="/admin/catalog"
        />
      ) : activeTab === 'brochures-qa' ? (
        <BrochuresView />
      ) : (
        <>
          <div
            className="flex flex-wrap gap-2 mb-5"
            role="group"
            aria-label={t('catalog.promosViewsLabel')}
            data-testid="promos-views"
          >
            <Chip
              variant="filter"
              pressed={promosView === 'review'}
              onClick={() => setPromosView('review')}
            >
              {t('catalog.promosViewReview')}
            </Chip>
            <Chip
              variant="filter"
              pressed={promosView === 'catalog'}
              onClick={() => setPromosView('catalog')}
            >
              {t('catalog.promosViewCatalog')}
            </Chip>
          </div>
          {promosView === 'review' ? (
            <PromosReview />
          ) : (
            <PromosView
              onJump={(productKey) => navigate({ to: '/prices', search: {}, hash: productKey })}
            />
          )}
        </>
      )}
    </>
  )
}
