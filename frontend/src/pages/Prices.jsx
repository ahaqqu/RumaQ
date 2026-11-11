import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { Chip } from '../components/Chip.jsx'
import { Panel } from '../components/Panel.jsx'
import { SkeletonRows } from '../components/ui.jsx'
import { ProductsView } from './ProductsView.jsx'
import { PromosView } from './PromosView.jsx'
import { useMe } from '../lib/queries/me.js'
import { normalizeHash, resolvePriceView } from '../lib/pricesHelpers.js'

// Lead copy per catalog view; the Products explorer keeps prices.lead.
const LEAD_KEY_BY_VIEW = {
  promos: 'prices.promosLead',
}

// Products|Promos shell for /prices (issue #292 PM §3, #293 PM §2).
// The search text and source filter live here (not inside ProductsView) so
// the promo view's example jump can clear them — a jump is a fresh browse
// context that must land inside the unfiltered 200.
//
// #631: /prices is the end-user explorer for every household user, admins
// included. The Brochures tab and every admin/QA tool (rename, alias
// candidates, duplicate names) moved to /admin/catalog; this page never
// renders them, whatever me.user.isAdmin says.
export function Prices() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const [search, setSearch] = useState('')
  const [source, setSource] = useState(null)
  const [category, setCategory] = useState(null)

  // ?view=promos selects a catalog view; a #productKey hash is the stronger
  // intent and forces the Products view regardless of the param (PM AC 7 /
  // #293 AC 5) — one shared resolver (lib/pricesHelpers.js).
  const { view } = useSearch({ strict: false })
  const activeView = resolvePriceView(view, location.hash)

  // #631: the Brochures view moved to the admin catalog. The old
  // ?view=brochures deep link must not 404: an admin is redirected to the
  // admin catalog's Brochures tab (a #productKey hash still wins and opens
  // Products there), everyone else silently lands on Products.
  const { data: me, isLoading: meLoading } = useMe()
  const isAdmin = me?.user?.isAdmin === true
  const legacyBrochures = view === 'brochures'
  const hash = normalizeHash(location.hash)
  // #631 review: until the identity resolves we must not guess — rendering
  // the explorer for the legacy link would fire the price query and flash the
  // moved view before an admin redirect (or a non-admin fallback) lands.
  const identityPending = legacyBrochures && meLoading

  useEffect(() => {
    if (!legacyBrochures || !isAdmin) return
    navigate({
      to: '/admin/catalog',
      search: hash ? {} : { tab: 'brochures' },
      hash,
      replace: true,
    })
  }, [legacyBrochures, isAdmin, hash, navigate])

  // While the identity loads or the admin redirect is in flight, render a
  // pending state — never the Products explorer, which used to sit under the
  // removed Brochures tab.
  if (identityPending || (legacyBrochures && isAdmin)) {
    return (
      <Panel>
        <SkeletonRows n={3} />
      </Panel>
    )
  }

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
    setCategory(null)
    navigate({ to: '/prices', search: {}, hash: productKey, replace: false })
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
          pressed={activeView === 'promos'}
          onClick={() => selectView('promos')}
        >
          {t('prices.viewPromos')}
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
        <PromosView onJump={jump} />
      )}
    </>
  )
}
