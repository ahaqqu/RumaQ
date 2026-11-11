import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { useMe } from '../lib/queries/me.js'
import { EmptyState } from '../components/ui.jsx'
import { Panel } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { ProductsView } from './ProductsView.jsx'
import { BrochuresView } from './BrochuresView.jsx'
import { resolveCatalogTab } from '../lib/pricesHelpers.js'
import { IconWarning } from '../components/icons.jsx'

// The admin catalog (issue #631): the home of the admin/QA tools that used to
// be mixed into the end-user /prices explorer. Two sections:
//
// - Products — the product lookup/search + expanded detail (rename for
//   admins) plus the duplicate-names report and alias-candidates action,
//   reusing ProductsView with adminTools. A #productKey deep link opens this
//   section and expands/scrolls the product (ProductsView owns that effect).
// - Brochures — the ingestion-QA browser moved off /prices and reworked for
//   #630: store/date filters, a multi-column brochure grid, and an in-place
//   review section with every product and its full ingestion metadata. It no
//   longer jumps into the Products section (the old #productKey jump landed on
//   the wrong/ambiguous item).
//
// ?tab= selects the section; the retired /prices?view=brochures deep link
// redirects an admin here on the Brochures tab. The route guard is the same
// client-side pattern as AdminPrices/AdminReview/AdminScrape (useMe +
// unauthorized state); the APIs behind every tool are already requireAdmin.
export function AdminCatalog() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { data: me } = useMe()
  const isAdmin = me?.user?.isAdmin === true

  const { tab } = useSearch({ strict: false })
  const activeTab = resolveCatalogTab(tab, location.hash)

  // Search text and the source/category filters live here (not inside
  // ProductsView) so they survive a tab switch.
  const [search, setSearch] = useState('')
  const [source, setSource] = useState(null)
  const [category, setCategory] = useState(null)

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

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">{t('catalog.lead')}</p>
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
          pressed={activeTab === 'brochures'}
          onClick={() => selectTab('brochures')}
        >
          {t('catalog.tabBrochures')}
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
      ) : (
        <BrochuresView />
      )}
    </>
  )
}
