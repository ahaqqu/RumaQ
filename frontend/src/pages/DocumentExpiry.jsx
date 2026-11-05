import { useTranslation } from 'react-i18next'
import { Badge } from '../components/Badge.jsx'
import { Panel, PanelHead } from '../components/Panel.jsx'
import { Button } from '../components/Button.jsx'
import {
  DOCUMENT_DEFAULT_REMIND_DAYS,
  DOCUMENT_REMIND_DAYS_MIN,
  DOCUMENT_REMIND_DAYS_MAX,
} from '../lib/api'
import { IconClock } from '../components/icons.jsx'

// The #426 expiry surfaces as presentational components (V2-B2), split out of
// Documents.jsx by the page-sibling convention (DocumentViewer.jsx): the page
// stays the state owner, these read only doc data, i18n and callbacks — so
// the chip/due-soon/editor contracts are unit-testable without mounting the
// whole page. Server data shape: each doc carries expires_on, remind_days_before
// and the COMPUTED days_until_expiry (whole days on the household calendar,
// UTC+7 — negative = expired).

// The expiry chip tone, mirroring the issue's thresholds: red under 7 days
// (already-expired documents included — they are the most urgent), amber
// under 30, muted beyond. null = no expiry set → no chip at all.
export function expiryTone(days) {
  if (days === null || days === undefined) return null
  if (days < 7) return 'danger'
  if (days < 30) return 'warn'
  return 'muted'
}

export function ExpiryBadge({ days }) {
  const { t } = useTranslation()
  if (days === null || days === undefined) return null
  const label =
    days < 0
      ? t('documents.expiredDaysAgo', { count: -days })
      : days === 0
        ? t('documents.expiresToday')
        : t('documents.expiresInDays', { count: days })
  return (
    <Badge tone={expiryTone(days)} data-testid="expiry-chip">
      {label}
    </Badge>
  )
}

// Due soon (#426): every document whose computed distance has entered its
// own reminder window (NULL window reads as the 30-day default — the same
// rule the nightly sweep applies), sorted soonest expiry first. The page's
// memo calls this with the list it already holds: one fetch, and the section
// can never disagree with the vault list.
export function selectDueSoon(documents) {
  return (documents ?? [])
    .filter(
      (d) =>
        d.days_until_expiry !== null &&
        d.days_until_expiry !== undefined &&
        d.days_until_expiry <= (d.remind_days_before ?? DOCUMENT_DEFAULT_REMIND_DAYS)
    )
    .sort((a, b) => a.days_until_expiry - b.days_until_expiry)
}

export function DueSoonSection({ docs, memberNameById }) {
  const { t } = useTranslation()
  return (
    <Panel>
      <PanelHead>
        <div className="flex items-center gap-2">
          <IconClock size={18} className="text-warn shrink-0" />
          <div>
            <div className="font-semibold">{t('documents.dueSoonTitle')}</div>
            <div className="text-sm text-text-muted mt-0.5">{t('documents.dueSoonHint')}</div>
          </div>
        </div>
      </PanelHead>
      <div data-testid="due-soon">
        {docs.map((doc) => (
          <div
            key={doc.id}
            data-testid="due-soon-row"
            className="px-5 py-3 border-b border-border last:border-b-0 flex items-center gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{doc.name}</div>
              <div className="text-sm text-text-muted truncate">
                {doc.member_id && <> {memberNameById.get(doc.member_id) ?? ''} · </>}
                {t('documents.remindLabel')}:{' '}
                {doc.remind_days_before ?? DOCUMENT_DEFAULT_REMIND_DAYS}
              </div>
            </div>
            <ExpiryBadge days={doc.days_until_expiry} />
          </div>
        ))}
      </div>
    </Panel>
  )
}

// The inline expiry editor (#426): a date input plus the optional remind
// window, rendered below the row it edits (the add-files form's placement).
// Clearing the date sends expires_on: null — the server clears the window
// with it; the window field is ignored then (and disabled until a date
// exists), so there is never a dangling window.
export function ExpiryEditForm({ doc, draft, onDraftChange, onSave, onCancel, saving }) {
  const { t } = useTranslation()
  return (
    <div className="px-5 py-4 border-b border-border flex flex-col gap-3" data-testid="expiry-edit">
      <div className="font-medium text-sm">
        {t('documents.editExpiry')} · {doc.name}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm min-w-0">
          <span className="text-text-muted">{t('documents.expiryLabel')}</span>
          <input
            type="date"
            value={draft.expiresOn}
            onChange={(e) => onDraftChange({ ...draft, expiresOn: e.target.value })}
            aria-label={t('documents.expiryLabel')}
            data-testid="expiry-date"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm min-w-0">
          <span className="text-text-muted">{t('documents.remindLabel')}</span>
          {/* A window without an expiry is meaningless — disabled until the
              date is set; the server clears the stored window together with
              the expiry anyway. */}
          <input
            type="number"
            min={DOCUMENT_REMIND_DAYS_MIN}
            max={DOCUMENT_REMIND_DAYS_MAX}
            value={draft.remindDays}
            disabled={!draft.expiresOn}
            onChange={(e) => onDraftChange({ ...draft, remindDays: e.target.value })}
            aria-label={t('documents.remindLabel')}
            data-testid="remind-days"
          />
          <span className="text-xs text-text-muted">{t('documents.remindHint')}</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={saving} data-testid="expiry-save">
          {t('documents.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {t('documents.cancel')}
        </Button>
      </div>
      <div className="text-xs text-text-muted">{t('documents.expiryHint')}</div>
    </div>
  )
}
