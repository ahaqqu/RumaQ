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
      className="flex items-center gap-2 px-4 py-2 lg:px-9 bg-accent-soft text-accent text-xs lg:text-sm"
    >
      <IconOffline size={15} className="shrink-0" />
      {t('offline.banner')}
    </div>
  )
}
