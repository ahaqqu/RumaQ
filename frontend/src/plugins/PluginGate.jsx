import { useTranslation } from 'react-i18next'
import { EmptyState } from '../components/EmptyState.jsx'
import { catalogEntryById } from './registry.js'
import { usePluginCatalog } from './context.jsx'

/**
 * The route gate (ahaqqu/RumaQ#436 — plugin architecture phase B, plan
 * §4.5): each plugin-owned route wraps its component in this gate — enabled
 * renders, disabled shows the calm empty state (§3.2). URLs never move and
 * file-based routing stays as it is; the gate IS the route contribution.
 * The copy stays intentionally generic (no enable affordance yet — the
 * settings catalog is ticket 3) and reads the plugin's own label so the
 * same gate serves every plugin without per-plugin copy.
 */
export function PluginGate({ plugin, children }) {
  const { isEnabled } = usePluginCatalog()
  const { t } = useTranslation()

  if (isEnabled(plugin)) return children

  const entry = catalogEntryById(plugin)
  const feature = entry ? t(entry.labelKey) : plugin
  return (
    <EmptyState
      icon={entry?.icon}
      title={t('plugins.disabledTitle', { feature })}
      desc={t('plugins.disabledDesc')}
    />
  )
}
