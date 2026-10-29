import { useRegisterSW } from 'virtual:pwa-register/react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button.jsx'

// Prompt-to-update flow (vite-plugin-pwa registerType: 'prompt'): the new
// service worker waits in `installed` state until the user accepts. Reload
// posts SKIP_WAITING to the waiting worker and reloads once it takes control;
// dismiss only hides the banner until the next needRefresh event.
export function PwaUpdatePrompt() {
  const { t } = useTranslation()
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] bg-surface-raised border border-border rounded-md px-5 py-3 flex gap-3 items-center shadow-lg"
    >
      <span className="text-sm">{t('pwa.updateAvailable')}</span>
      <Button size="sm" onClick={() => updateServiceWorker(true)}>
        {t('pwa.reload')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setNeedRefresh(false)}>
        {t('pwa.dismiss')}
      </Button>
    </div>
  )
}
