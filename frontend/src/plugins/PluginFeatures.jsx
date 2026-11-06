import { useTranslation } from 'react-i18next'
import { Panel, PanelHead, PanelBody } from '../components/Panel.jsx'
import { Chip } from '../components/Chip.jsx'
import { SkeletonRows } from '../components/ui.jsx'
import { usePluginCatalog, useSetPluginEnablement } from '../lib/queries/index.js'
import { PLUGIN_CATALOG } from './registry.js'

/**
 * The plugins settings catalog (ahaqqu/RumaQ#437 — plugin architecture
 * ticket 3, docs/plan/plugin-architecture.md §4.5). CORE-owned section
 * rendered in the household-admin screen: one row per registered plugin,
 * each with its declared capabilities and its three-layer effective-access
 * posture reported honestly (§3.3) — deployment availability (the ops
 * kill-switch; routes answer 404 while off), plan entitlement (403, the
 * only actionable denial; every plan carries every plugin tonight), and the
 * household toggle itself (routes 404 while off). A row with nothing to
 * flag renders no posture line: the switch position IS the household layer.
 * The enable/disable switch is owner-only; members get a read-only state
 * chip. State rides the ['plugin-catalog'] query; the toggle's mutation also
 * updates the /api/me cache so the nav gating reacts without a reload. That
 * ONE mutation instance is owned here and handed to the rows — see the note
 * at its call site.
 */

// One accessible switch — the project has no shared Switch primitive, so the
// smallest honest control is a button with switch semantics (no hidden
// checkbox, no div-with-onClick).
function Switch({ checked, pending, label, onToggle }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={pending}
      onClick={onToggle}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        checked ? 'bg-accent border-accent' : 'bg-surface-inset border-border'
      } disabled:opacity-50`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-surface shadow transition-all ${
          checked ? 'left-[22px]' : 'left-[2px]'
        }`}
      />
    </button>
  )
}

// The top-most blocked layer gets the line, in denial-code order: the ops
// kill-switch (404), the paywall (403), then the household choice (404) with
// its retention promise (§3.4 — disable never deletes).
function Posture({ plugin }) {
  const { t } = useTranslation()
  if (!plugin.deployment_available) {
    return (
      <div className="mt-1.5 text-sm text-accent-hover" title={t('plugins.deploymentOffHint')}>
        {t('plugins.deploymentOff')}
      </div>
    )
  }
  if (!plugin.plan_entitled) {
    return <div className="mt-1.5 text-sm text-danger">{t('plugins.planExcluded')}</div>
  }
  if (!plugin.enabled) {
    return <div className="mt-1.5 text-sm text-text-muted">{t('plugins.retentionNote')}</div>
  }
  return null
}

function PluginRow({ entry, plugin, isOwner, mutation }) {
  const { t } = useTranslation()
  // The mutation is panel-owned (hoisted into PluginFeatures) — per-row
  // pending rides its `variables`, so only the switch the user is toggling
  // shows the in-flight state.
  const pending = mutation.isPending && mutation.variables?.pluginId === entry.id
  const toggle = () =>
    mutation.mutate({ pluginId: entry.id, status: plugin.enabled ? 'disabled' : 'enabled' })
  return (
    <div className="px-5 py-4 border-b border-border last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl grid place-items-center bg-surface-inset text-text shrink-0">
          <entry.icon size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t(entry.labelKey)}</div>
          <div className="text-sm text-text-muted mt-0.5">{t(entry.descriptionKey)}</div>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {entry.capabilities.map((capability) => (
              <Chip key={capability}>{t(`plugins.capabilities.${capability}`)}</Chip>
            ))}
          </div>
          <Posture plugin={plugin} />
        </div>
        {isOwner ? (
          <Switch
            checked={plugin.enabled}
            pending={pending}
            label={t('plugins.toggleAria', { feature: t(entry.labelKey) })}
            onToggle={toggle}
          />
        ) : (
          <Chip variant={plugin.enabled ? 'accent' : 'default'}>
            {plugin.enabled ? t('plugins.stateOn') : t('plugins.stateOff')}
          </Chip>
        )}
      </div>
    </div>
  )
}

export function PluginFeatures({ isOwner }) {
  const { t } = useTranslation()
  const { data, isPending, isError } = usePluginCatalog()
  // ONE owner of the toggle's mutation state: each useMutation call observes
  // only the mutations its own mutate() builds, so a second observer (e.g. a
  // dedicated error component) never sees a row's failure. The hoisted
  // instance is handed to every row — per-row pending keys off its
  // `variables` — and the panel-wide alert below renders from the same
  // state, so a failed toggle is impossible to miss.
  const mutation = useSetPluginEnablement()
  // Registry order IS render order (the server list rides the same order,
  // but the join is by id — the static contributions own the presentation).
  const rows = PLUGIN_CATALOG.map((entry) => ({
    entry,
    plugin: data?.plugins?.find((plugin) => plugin.id === entry.id),
  })).filter((row) => row.plugin)

  return (
    <Panel>
      <PanelHead>
        <div>
          <div className="font-semibold">{t('plugins.catalogTitle')}</div>
          <div className="text-sm text-text-muted mt-0.5">{t('plugins.catalogSubtitle')}</div>
        </div>
      </PanelHead>
      {isPending ? (
        <PanelBody>
          <SkeletonRows n={1} />
        </PanelBody>
      ) : isError ? (
        <PanelBody>
          <div role="alert" className="text-sm text-text-muted">
            {t('plugins.errorGeneric')}
          </div>
        </PanelBody>
      ) : (
        <div>
          {!isOwner && (
            <div className="px-5 pt-3 text-sm text-text-muted">{t('plugins.membersHint')}</div>
          )}
          {rows.map(({ entry, plugin }) => (
            <PluginRow
              key={entry.id}
              entry={entry}
              plugin={plugin}
              isOwner={isOwner}
              mutation={mutation}
            />
          ))}
          {/* The mutation error surfaces once, panel-wide, from the SAME
              hoisted instance the rows toggle: the row that failed is
              whichever switch the user last touched, and the mutation's
              rollback already restored the honest cache. */}
          {mutation.isError && (
            <div role="alert" className="px-5 pb-4 text-sm text-danger">
              {t('plugins.errorGeneric')}
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
