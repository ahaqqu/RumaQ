import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconEye } from '../components/icons.jsx'

// One brochure card, shared by the admin QA grid and the user gallery (the
// #718 review B1 follow-up — the two cards were near-duplicates): the 3:4
// frame is reserved up front (no layout shift), the image is lazy, and a
// missing object degrades to a text fallback in the same frame — never a
// broken-image glyph.
//
// `linked` selects the surface's affordance:
// - true (the admin QA tab): the whole card is the anchor into the
//   chrome-less viewer with ?admin=true (issue #716) — normal new-tab
//   semantics (middle-click/ctrl-click) apply. A viewerUrl that is not the
//   canonical shape renders an inert anchor (the #718 A2 finding — left
//   unchanged here).
// - false (the user gallery, issue #673): the card itself does nothing; the
//   explicit View link (#674) opens the full-mode viewer in a new tab (the
//   session cookie is SameSite=Lax, so the top-level blank navigation
//   carries it — the AdminReview evidence-link precedent). No viewerUrl, no
//   View link.
export function BrochureCard({ group, dateLabel, viewerUrl, linked = false }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const Root = linked ? 'a' : 'div'
  return (
    <Root
      {...(linked ? { href: viewerUrl, target: '_blank', rel: 'noreferrer' } : {})}
      data-testid="brochure-card"
      className={
        linked
          ? 'group flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-left transition-colors hover:border-border-strong'
          : 'flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-raised'
      }
    >
      <div
        className="relative w-full overflow-hidden bg-surface-sunken/40"
        style={{ aspectRatio: '3 / 4' }}
      >
        {!failed && (
          <img
            src={group.brochure_url}
            alt={t('prices.brochureAlt', { store: group.source_name })}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        )}
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-3 text-center">
            <div className="text-sm font-medium">{group.source_name}</div>
            <div className="text-xs text-text-muted">
              {t('prices.productsCount', { count: group.product_count })}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-2.5">
        <div className="truncate text-sm font-medium">{group.source_name}</div>
        <div className="text-xs text-text-muted">{dateLabel}</div>
        <div className="text-xs text-text-muted">
          {t('prices.productsCount', { count: group.product_count })}
        </div>
        {!linked && viewerUrl && (
          <a
            href={viewerUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 self-start rounded-sm text-xs font-semibold text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <IconEye size={14} className="shrink-0" />
            {t('prices.viewerOpen')}
            <span className="sr-only">— {group.source_name}</span>
          </a>
        )}
      </div>
    </Root>
  )
}
