import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { formatRp } from '../data/mock.js'
import { usePersona } from '../context/PersonaContext.jsx'
import { personaText } from '../lib/persona.js'
import { scanReceipt, createPurchase, getStores, getItems } from '../lib/api'
import {
  IconCamera,
  IconUpload,
  IconCheck,
  IconBolt,
  IconReceipt,
  IconWarning,
  IconArrowLeft,
  IconShop,
  IconCalendarBlank,
} from '../components/icons.jsx'
import { cn } from '../lib/cn.js'
import { Button } from '../components/Button.jsx'
import { Chip } from '../components/Chip.jsx'
import { Panel, PanelHead, PanelBody, PanelFoot } from '../components/Panel.jsx'
import { SkeletonLines } from '../components/Skeleton.jsx'

const MAX_SIZE = 5 * 1024 * 1024
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp']

export function AddFromReceipt({ onDone }) {
  const { t } = useTranslation()
  const { persona } = usePersona()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [phase, setPhase] = useState('capture')
  const [error, setError] = useState(null)
  const [items, setItems] = useState([])
  const [selectedStore, setSelectedStore] = useState(null)
  const [stores, setStores] = useState([])
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [itemCatalog, setItemCatalog] = useState([])
  const [selectedItemIds, setSelectedItemIds] = useState({})
  const [imageKey, setImageKey] = useState(null)
  const [imageUrl, setImageUrl] = useState(null)
  const [creating, setCreating] = useState(false)

  const isNoKeyError =
    error && (error.includes('AI provider not configured') || error.includes('Settings'))

  function triggerFileInput(captureMode) {
    if (fileInputRef.current) {
      if (captureMode) {
        fileInputRef.current.setAttribute('capture', 'environment')
      } else {
        fileInputRef.current.removeAttribute('capture')
      }
      fileInputRef.current.click()
    }
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (file) handleFileInner(file)
  }

  function handleDrop(e) {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (file) handleFileInner(file)
  }

  function handleDragOver(e) {
    e.preventDefault()
  }

  async function handleFileInner(file) {
    setError(null)

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Unsupported file type. Accepted: JPEG, PNG, HEIC, WEBP.')
      return
    }
    if (file.size > MAX_SIZE) {
      setError('File too large. Maximum size is 5 MB.')
      return
    }

    setPhase('scanning')

    try {
      const result = await scanReceipt(file)
      setItems(result.items.map((it, i) => ({ ...it, _id: `item-${i}` })))
      setImageKey(result.imageKey)
      setImageUrl(result.imageUrl)
      if (result.storeGuess) {
        setSelectedStore(result.storeGuess.id)
      }
      if (result.dateGuess) {
        setDate(result.dateGuess)
      }

      try {
        const [storesData, itemsData] = await Promise.all([getStores(), getItems()])
        setStores(storesData.stores || [])
        setItemCatalog(itemsData.items || [])
      } catch {
        setStores([])
        setItemCatalog([])
      }

      setPhase('review')
    } catch (err) {
      setError(err.message)
      setPhase('capture')
    }
  }

  function updateItem(id, field, value) {
    setItems((prev) => prev.map((it) => (it._id === id ? { ...it, [field]: value } : it)))
  }

  function selectItemMatch(id, catalogItemId) {
    setSelectedItemIds((prev) => ({ ...prev, [id]: catalogItemId }))
    if (catalogItemId) {
      const match = itemCatalog.find((c) => c.id === catalogItemId)
      if (match) {
        setItems((prev) =>
          prev.map((it) =>
            it._id === id ? { ...it, name: match.name, unit: match.unit || it.unit } : it
          )
        )
      }
    }
  }

  async function handleConfirm() {
    setCreating(true)
    setError(null)

    try {
      const payload = {
        store_id: selectedStore || undefined,
        date,
        receipt_image_key: imageKey || undefined,
        items: items.map((it) => ({
          name: it.name,
          qty: Number(it.qty) || 1,
          unit: it.unit || 'pcs',
          price: Math.round(Number(it.price)) || 0,
          item_id: selectedItemIds[it._id] || undefined,
        })),
      }

      await createPurchase(payload)
      setPhase('done')
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  function handleRetake() {
    setPhase('capture')
    setItems([])
    setError(null)
    setImageKey(null)
    setImageUrl(null)
  }

  // Sum qty × price per line — summing price alone reads as a bogus total on
  // multi-quantity receipts.
  const lineTotal = items.reduce((a, b) => a + (Number(b.qty) || 0) * (Number(b.price) || 0), 0)

  return (
    <>
      <div className="mb-6">
        <p className="text-md text-text-muted leading-snug max-w-[62ch]">
          {personaText('receiptLead', persona, t)}
        </p>
      </div>

      {error && (
        <Panel className="mb-4 p-3 bg-danger-soft border-danger-border">
          <div className="flex gap-2 items-start">
            <IconWarning size={18} className="text-danger shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-danger">{error}</p>
              {isNoKeyError && (
                <Button
                  variant="ghost"
                  className="mt-2 text-sm"
                  onClick={() => navigate({ to: '/settings' })}
                >
                  {t('addReceipt.goToSettings') || 'Go to Settings'}
                </Button>
              )}
            </div>
          </div>
        </Panel>
      )}

      {phase === 'capture' && (
        <div
          className={cn(
            'border-2 border-dashed border-border-strong rounded-lg px-6 py-12 text-center bg-surface-raised',
            'transition-colors hover:border-accent hover:bg-accent-soft cursor-pointer'
          )}
          role="button"
          tabIndex={0}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => triggerFileInput(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') triggerFileInput(false)
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/heic,image/webp"
            className="hidden"
            onChange={handleFileChange}
            data-testid="file-input"
          />
          <div className="w-14 h-14 rounded-lg mx-auto mb-4 bg-accent-soft grid place-items-center text-accent">
            <IconCamera size={26} />
          </div>
          <div className="font-semibold text-md">{t('addReceipt.takePhoto')}</div>
          <div className="text-text-muted text-sm mt-2">{t('addReceipt.dropHint')}</div>
          <div className="mt-5 flex gap-3 justify-center">
            <Button
              onClick={(e) => {
                e.stopPropagation()
                triggerFileInput(true)
              }}
            >
              <IconCamera size={18} /> {t('addReceipt.openCamera')}
            </Button>
            <Button
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation()
                triggerFileInput(false)
              }}
            >
              <IconUpload size={18} /> {t('addReceipt.uploadFile')}
            </Button>
          </div>
        </div>
      )}

      {phase === 'scanning' && (
        <Panel className="p-9 text-center">
          <div className="mx-auto mb-5 text-accent">
            <IconBolt size={32} className="animate-spin" />
          </div>
          <div className="font-semibold text-md">{t('addReceipt.scanningTitle')}</div>
          <div className="text-text-muted text-sm mt-2">{t('addReceipt.scanningDesc')}</div>
          <div className="max-w-[360px] mx-auto mt-5">
            <SkeletonLines />
          </div>
        </Panel>
      )}

      {phase === 'review' && (
        <>
          <div className="flex flex-wrap gap-2 mb-4">
            {selectedStore && (
              <Chip variant="loc">
                <IconShop size={14} />{' '}
                {stores.find((s) => s.id === selectedStore)?.label || selectedStore}
              </Chip>
            )}
            <Chip>
              <IconCalendarBlank size={14} /> {date}
            </Chip>
            <Chip>{t('addReceipt.itemsRead', { count: items.length })}</Chip>
            <span className="flex-1" />
            <Chip variant="accent">{t('addReceipt.aiReview')}</Chip>
          </div>

          {imageUrl && (
            <div className="mb-4 rounded-md overflow-hidden max-h-[200px]">
              <img
                src={imageUrl}
                alt="Receipt"
                className="w-full h-auto object-contain max-h-[200px]"
              />
            </div>
          )}

          <Panel className="mb-4">
            <PanelBody className="flex flex-wrap gap-3">
              <div className="flex-1 min-w-[150px]">
                <label className="block text-xs text-text-muted mb-1">
                  {t('history.store') || 'Store'}
                </label>
                <select
                  value={selectedStore || ''}
                  onChange={(e) => setSelectedStore(e.target.value || null)}
                  className="w-full"
                >
                  <option value="">{t('addReceipt.selectStore') || 'Select store...'}</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[150px]">
                <label className="block text-xs text-text-muted mb-1">
                  {t('history.date') || 'Date'}
                </label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full"
                />
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead>
              <h2>{t('addReceipt.reviewTitle')}</h2>
              <span className="text-sm text-text-muted">{t('addReceipt.editHint')}</span>
            </PanelHead>
            <PanelBody className="!py-0">
              {items.map((it) => (
                <div
                  key={it._id}
                  className="grid grid-cols-1 sm:grid-cols-[1fr_90px_110px] gap-2 items-center py-3 border-b border-border last:border-b-0"
                >
                  <div className="flex gap-2 items-center min-w-0">
                    <select
                      value={selectedItemIds[it._id] || ''}
                      onChange={(e) => selectItemMatch(it._id, e.target.value || null)}
                      className="min-w-[120px]"
                      aria-label="Match to existing item"
                    >
                      <option value="">{t('addReceipt.keepNew') || '— New item —'}</option>
                      {itemCatalog.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <input
                      value={it.name}
                      onChange={(e) => updateItem(it._id, 'name', e.target.value)}
                      aria-label={t('history.item')}
                      className="min-w-0"
                      placeholder={t('addReceipt.itemName') || 'Item name'}
                    />
                  </div>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={it.qty}
                    onChange={(e) => updateItem(it._id, 'qty', e.target.value)}
                    aria-label={t('common.from')}
                    className="w-[90px]"
                  />
                  <input
                    value={it.unit}
                    onChange={(e) => updateItem(it._id, 'unit', e.target.value)}
                    aria-label="Unit"
                    className="w-[110px]"
                  />
                  <input
                    type="number"
                    min="0"
                    value={it.price}
                    onChange={(e) => updateItem(it._id, 'price', e.target.value)}
                    aria-label={t('history.price')}
                    className="w-[110px]"
                  />
                </div>
              ))}
            </PanelBody>
            <PanelFoot className="justify-between">
              <div className="text-text-muted text-sm">
                {t('addReceipt.total')} <strong className="text-text">{formatRp(lineTotal)}</strong>
              </div>
              <div className="flex gap-3">
                <Button variant="ghost" onClick={handleRetake}>
                  <IconArrowLeft size={18} /> {t('addReceipt.retake')}
                </Button>
                <Button onClick={handleConfirm} disabled={creating}>
                  {creating ? (
                    <>
                      <IconBolt size={18} className="animate-spin" /> {t('addReceipt.confirmAdd')}
                    </>
                  ) : (
                    <>
                      <IconCheck size={18} /> {t('addReceipt.confirmAdd')}
                    </>
                  )}
                </Button>
              </div>
            </PanelFoot>
          </Panel>
        </>
      )}

      {phase === 'done' && (
        <Panel className="p-9 text-center">
          <div className="mx-auto mb-5 text-ok">
            <div className="w-14 h-14 rounded-full bg-ok-soft grid place-items-center mx-auto">
              <IconCheck size={28} />
            </div>
          </div>
          <div className="font-semibold text-base">
            {t('addReceipt.stockAdded', { count: items.length })}
          </div>
          <div className="text-text-muted text-sm mt-2">{t('addReceipt.stockUpdatedDesc')}</div>
          <div className="mt-5 flex gap-3 justify-center">
            <Button variant="secondary" onClick={handleRetake}>
              <IconReceipt size={18} /> {t('addReceipt.addAnother')}
            </Button>
            <Button onClick={onDone}>{t('addReceipt.done')}</Button>
          </div>
        </Panel>
      )}
    </>
  )
}
