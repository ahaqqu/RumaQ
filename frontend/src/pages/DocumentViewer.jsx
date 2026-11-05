import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchDocumentContent } from '../lib/api'
import { Button } from '../components/Button.jsx'
import { IconClose } from '../components/icons.jsx'

// In-app viewer (own module since review B2 of #422, matching the
// page-sibling component convention — ProductsView/PromosView): the blob URL
// is fetched with the session cookie (inline disposition — audited as a view
// server-side), previewed in-app, and always revoked on close/unmount.
// Images render inline; PDF via the object embed. Per file since #422 — the
// content endpoint is /documents/:id/files/:fileId.
export function DocumentViewer({ documentId, file, onClose }) {
  const { t } = useTranslation()
  const [objectUrl, setObjectUrl] = useState(null)
  const [error, setError] = useState(false)
  const dialogRef = useRef(null)
  // The close callback is read from a ref so the focus contract below mounts
  // exactly once (the parent passes an inline handler that changes identity
  // on every render).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Modal-dialog focus contract (the AppShell drawer pattern): focus enters
  // the panel when it opens, Tab stays inside it while the overlay occludes
  // the page, Escape closes, and unmounting hands focus back to whatever
  // opened it.
  useEffect(() => {
    const panel = dialogRef.current
    const previouslyFocused = document.activeElement
    panel?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const focusables = panel.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const inside = active !== panel && panel.contains(active)
      if (!inside) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (previouslyFocused instanceof HTMLElement && previouslyFocused !== document.body) {
        previouslyFocused.focus()
      }
    }
  }, [])

  useEffect(() => {
    let url = null
    let cancelled = false
    fetchDocumentContent(documentId, file.id, 'inline')
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setObjectUrl(url)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [documentId, file.id])

  const isImage = file.content_type.startsWith('image/')

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4 outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={file.file_name}
    >
      <div className="flex items-center justify-between gap-3 pb-3 text-white">
        <div className="min-w-0 truncate text-sm font-medium">
          {file.label ? `${file.label} · ` : ''}
          {file.file_name}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={t('documents.closeViewer')}>
          <IconClose size={16} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl bg-surface p-2">
        {error ? (
          <p className="text-sm text-danger">{t('documents.viewerError')}</p>
        ) : !objectUrl ? (
          <p className="text-sm text-text-muted">{t('documents.viewerLoading')}</p>
        ) : isImage ? (
          <img
            src={objectUrl}
            alt={file.label || file.file_name}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        ) : file.content_type === 'application/pdf' ? (
          <embed src={objectUrl} type="application/pdf" className="h-full w-full rounded-lg" />
        ) : (
          <p className="text-sm text-text-muted">{t('documents.viewerUnsupported')}</p>
        )}
      </div>
    </div>
  )
}
