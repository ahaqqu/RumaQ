import { useTranslation } from 'react-i18next'
import { useOnlineStatus } from '../lib/useOnlineStatus.js'
import { IconOffline } from './icons.jsx'

export function OfflineBanner() {
  const { t } = useTranslation()
  const isOnline = useOnlineStatus()

  if (isOnline) return null

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 px-4 py-2 bg-surface-raised border-b border-border text-text-muted text-sm"
    >
      <IconOffline size={16} />
      {t('offline.banner')}
    </div>
  )
}
