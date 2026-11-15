import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearch } from '@tanstack/react-router'
import { usePriceBrochures } from '../lib/queries/index.js'
import { Button } from '../components/Button.jsx'
import { EmptyState } from '../components/EmptyState.jsx'
import { BrandMark, IconSearch } from '../components/icons.jsx'
import { BROCHURE_URL_PREFIX, observedDateLabel } from '../lib/pricesHelpers.js'

// The URL segment is 'YYYYMMDD'; the shared label contract expects
// 'YYYY-MM-DD', so bridge before formatting (the catalog's observed_date
// already carries the dashes — used directly when the group matches).
function viewerDateLabel(ymd, language) {
  if (!/^\d{8}$/.test(ymd ?? '')) return ymd ?? ''
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
  return observedDateLabel(iso, language)
}

// URL-derived store display name for the fallback title (the catalog is
// unavailable or has not hydrated yet): 'lotte-mart' → 'Lotte Mart'.
function prettifySlug(slug) {
  return (slug ?? '')
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// The chrome-less full-mode brochure viewer (#674): a slim top bar (RumaQ
// logo + the brochure title + Share) and the page image below it, phone-first
// full width. No AppShell chrome renders here — the route sits outside the
// _app layout — but the page is still Login-walled (the image proxy and the
// catalog are session-authenticated).
export function BrochureViewerPage() {
  const { t, i18n } = useTranslation()
  const { store, date, file } = useSearch({ strict: false })
  // Same query key as the gallery: the title resolves from TanStack cache
  // when navigating in-app and from the persisted query cache on a cold
  // deep-link load; while it loads (or offline/errored) the title falls back
  // to the URL-derived store + date.
  const { data } = usePriceBrochures()

  const hasBrochure = Boolean(store && date && file)
  const imageSrc = hasBrochure ? `${BROCHURE_URL_PREFIX}${store}/${date}/${file}` : null

  // Thermos A1 idiom (AdminReview): remember WHICH url failed, not a boolean
  // — a hard reload/refetch can swap the image; a boolean would pin the old
  // failure over a url that was never tried.
  const [failedUrl, setFailedUrl] = useState(null)
  const failed = imageSrc != null && failedUrl === imageSrc

  const group = useMemo(() => {
    if (!imageSrc) return null
    return (data?.groups ?? []).find((candidate) => candidate.brochure_url === imageSrc) ?? null
  }, [data, imageSrc])

  const storeName = group?.source_name ?? prettifySlug(store)
  const dateLabel = group
    ? observedDateLabel(group.observed_date, i18n.language)
    : viewerDateLabel(date, i18n.language)
  // The title must agree with the body: the body renders the unavailable
  // EmptyState whenever any segment was dropped by validateSearch, so gating
  // the title on `store` alone would hang a dangling "Lotte Mart · " (or a
  // complete-looking title) above a "no longer available" body.
  const title = hasBrochure ? `${storeName} · ${dateLabel}` : t('prices.viewerUnavailable')

  // The shareable URL is the viewer deep link itself — absolute, so it works
  // from the share sheet, another device, or the clipboard.
  const shareUrl = useMemo(() => {
    if (!hasBrochure) return null
    const query = new URLSearchParams({ store, date, file })
    return `${window.location.origin}/brochures/view?${query.toString()}`
  }, [hasBrochure, store, date, file])

  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const share = async () => {
    if (!shareUrl) return
    // Native share sheet where the platform provides one; the user dismissing
    // it is not a failure. Everything else (and every non-supporting browser)
    // falls back to copy-link + a 2s inline confirmation (Household idiom).
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url: shareUrl })
        return
      } catch (error) {
        if (error?.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    } catch {
      // Clipboard may be unavailable (permissions / insecure context): the
      // URL is in the address bar, so copying is a convenience — stay silent
      // rather than claim a copy that did not happen.
    }
  }

  return (
    <div className="min-h-dvh flex flex-col bg-surface">
      <div
        data-testid="viewer-topbar"
        className="sticky top-0 z-10 bg-surface-raised/90 backdrop-blur border-b border-border"
      >
        <div className="flex items-center gap-2.5 px-4 py-2.5 min-h-[60px] max-w-[720px] mx-auto w-full">
          <div className="flex items-center gap-2 shrink-0" aria-hidden="true">
            <BrandMark size={28} />
            <div className="font-bold text-[20px] leading-[26px] tracking-[-1px] text-accent">
              RumaQ
            </div>
          </div>
          <h1 className="flex-1 min-w-0 text-sm font-medium text-text truncate px-2">{title}</h1>
          {copied && (
            <span role="status" className="shrink-0 text-xs text-text-muted">
              {t('prices.viewerLinkCopied')}
            </span>
          )}
          <Button variant="secondary" size="sm" className="shrink-0" onClick={share}>
            {t('prices.viewerShare')}
          </Button>
        </div>
      </div>

      <div className="flex-1 w-full max-w-[560px] mx-auto px-4 py-4">
        {!hasBrochure ? (
          <EmptyState icon={IconSearch} title={t('prices.viewerUnavailable')} />
        ) : (
          <div
            className="relative w-full overflow-hidden rounded-lg border border-border bg-surface-raised"
            style={{ aspectRatio: '3 / 4' }}
          >
            {!failed && (
              <img
                src={imageSrc}
                alt={t('prices.brochureAlt', { store: storeName })}
                loading="eager"
                className="absolute inset-0 h-full w-full object-contain"
                onError={() => setFailedUrl(imageSrc)}
              />
            )}
            {failed && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-3 text-center">
                <div className="text-sm font-medium">{storeName}</div>
                <div className="text-xs text-text-muted">{dateLabel}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
