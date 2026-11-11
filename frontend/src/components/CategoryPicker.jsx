import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/cn.js'
import { IconCheck, IconChevronDown, IconClose, IconSearch } from './icons.jsx'

// Searchable category picker (issue #632): one trigger replaces the wall of
// ~49 taxonomy chips, which pushed the catalogue off screen. The list is the
// sealed v0.4 taxonomy exactly as /api/prices/meta hands it over — slugs are
// shown as-is and a hierarchy/rename would be a taxonomy version bump, not a
// UI change. Presentation only: the component owns no query state, it just
// reports the chosen slug (or null for "All categories") through `onChange`;
// ProductsView feeds the same `category` value into usePrices.
//
// A11y: the trigger is a button with aria-haspopup="listbox" / aria-expanded /
// aria-controls. The popover holds a combobox search input that keeps focus
// while open and drives the listbox through aria-activedescendant; options
// carry role="option" + aria-selected (the checked row). Arrow keys move the
// active entry, Enter selects it, Escape closes and returns focus to the
// trigger, and a mousedown outside the picker closes it. A permanent
// role="status" region carries the no-results announcement (#641). "All
// categories" is pinned at the top of the list and clears the filter (null).
export function CategoryPicker({ categories = [], value = null, onChange, className }) {
  const { t } = useTranslation()
  const baseId = useId()
  const listId = `${baseId}-listbox`
  const optionId = (index) => `${baseId}-option-${index}`

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)
  const searchRef = useRef(null)
  const optionRefs = useRef([])

  const selected = value ?? null
  const normalizedQuery = query.trim().toLowerCase()

  // The search filters the taxonomy slugs case-insensitively; the reset row is
  // a control, not a category, so it stays pinned above the matches.
  const matches = useMemo(
    () =>
      normalizedQuery
        ? categories.filter((slug) => slug.toLowerCase().includes(normalizedQuery))
        : categories,
    [categories, normalizedQuery]
  )
  const options = useMemo(
    () => [{ value: null }, ...matches.map((slug) => ({ value: slug }))],
    [matches]
  )
  const activeOption = options[activeIndex]

  // Focus moves into the search field when the panel opens: the combobox
  // owns the keyboard from there (the listbox is not a tab stop).
  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  // Click-outside closes without stealing focus back — the click target
  // decides where focus lands (the trigger's focus return is Escape/select).
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  // Keep the keyboard-active row visible in the scrollable 49-row list.
  useEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  // Index of the active row for a query: the selected category when the field
  // is empty, else the first match (the pinned reset row occupies index 0).
  const activeIndexForQuery = (nextQuery) => {
    const normalized = nextQuery.trim().toLowerCase()
    if (!normalized) {
      const index = categories.indexOf(selected)
      return index >= 0 ? index + 1 : 0
    }
    const matchIndex = categories.findIndex((slug) => slug.toLowerCase().includes(normalized))
    return matchIndex >= 0 ? matchIndex + 1 : 0
  }

  const openPanel = () => {
    setQuery('')
    setActiveIndex(activeIndexForQuery(''))
    setOpen(true)
  }

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const selectOption = (next) => {
    onChange?.(next)
    close()
  }

  const move = (delta) => {
    if (options.length === 0) return
    setActiveIndex((index) => (index + delta + options.length) % options.length)
  }

  const toggle = () => {
    if (open) close()
    else openPanel()
  }

  // Enter/Space on the button already open it (native activation); the arrow
  // keys open it too, like a combobox.
  const onTriggerKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!open) openPanel()
  }

  const onSearchKeyDown = (event) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(options.length - 1)
        break
      case 'Enter':
        event.preventDefault()
        if (activeOption) selectOption(activeOption.value)
        break
      default:
        break
    }
  }

  const onPanelKeyDown = (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  const changeQuery = (event) => {
    const next = event.target.value
    setQuery(next)
    setActiveIndex(activeIndexForQuery(next))
  }

  const clearQuery = () => {
    setQuery('')
    setActiveIndex(activeIndexForQuery(''))
    searchRef.current?.focus()
  }

  return (
    <div ref={containerRef} className={cn('relative', className)} data-testid="category-picker">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'inline-flex max-w-[min(22rem,calc(100vw-2rem))] min-h-9 items-center gap-2 rounded-pill border px-4 py-2 text-sm font-medium transition-colors',
          selected
            ? 'border-accent-soft-border bg-accent-soft text-accent-hover hover:bg-accent-soft'
            : 'border-border-strong bg-surface-raised text-text-muted hover:bg-surface-sunken'
        )}
      >
        {/* The visible text is the value; the prefix names the control (the
            old chip group's aria-label had no equivalent on a single button). */}
        <span className="sr-only">{t('prices.categoryFilterLabel')}: </span>
        <span className="truncate">{selected ?? t('prices.allCategories')}</span>
        <IconChevronDown
          size={14}
          aria-hidden="true"
          className={cn('shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          className="absolute left-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg"
          onKeyDown={onPanelKeyDown}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t('prices.categoryFilterLabel')}
            </span>
            <button
              type="button"
              aria-label={t('prices.categoryClose')}
              onClick={close}
              className="grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text"
            >
              <IconClose size={15} aria-hidden="true" />
            </button>
          </div>

          <div className="relative px-3 py-2">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-text-muted"
            >
              <IconSearch size={15} />
            </span>
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeOption ? optionId(activeIndex) : undefined}
              aria-label={t('prices.categorySearchPlaceholder')}
              value={query}
              onChange={changeQuery}
              onKeyDown={onSearchKeyDown}
              placeholder={t('prices.categorySearchPlaceholder')}
              className="w-full rounded-md border border-border bg-surface py-2 pl-8 pr-8 text-sm outline-none focus:border-accent"
            />
            {query && (
              <button
                type="button"
                aria-label={t('prices.categorySearchClear')}
                onClick={clearQuery}
                className="absolute right-5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-pill text-text-muted hover:bg-surface-sunken hover:text-text"
              >
                <IconClose size={12} aria-hidden="true" />
              </button>
            )}
          </div>

          <ul
            id={listId}
            role="listbox"
            aria-label={t('prices.categoryFilterLabel')}
            className="max-h-[min(50dvh,18rem)] overflow-y-auto pb-1"
          >
            {options.map((option, index) => {
              const isSelected = option.value === selected
              return (
                <li
                  key={option.value ?? '__all__'}
                  id={optionId(index)}
                  ref={(element) => {
                    optionRefs.current[index] = element
                  }}
                  role="option"
                  aria-selected={isSelected}
                  // Keep focus in the combobox so mousedown-then-click cannot
                  // drop the keyboard context before the selection lands.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectOption(option.value)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-text hover:bg-surface-sunken',
                    index === activeIndex && 'bg-surface-sunken',
                    isSelected && 'font-semibold text-accent-hover'
                  )}
                >
                  <span className="grid h-4 w-4 shrink-0 place-items-center text-accent-hover">
                    {isSelected && <IconCheck size={14} aria-hidden="true" />}
                  </span>
                  <span className="truncate">{option.value ?? t('prices.allCategories')}</span>
                </li>
              )
            })}
          </ul>

          {matches.length === 0 && (
            // Decorative for sighted users: the announcement comes from the
            // always-mounted status region below, so this copy is hidden from
            // assistive tech to avoid a second, unannounced reading.
            <p aria-hidden="true" className="px-3 pb-3 text-sm text-text-muted">
              {t('prices.categoryNoResults')}
            </p>
          )}
        </div>
      )}

      {/* #641: a live region that enters the DOM together with its text is not
          reliably announced, so the polite status node stays mounted for the
          lifetime of the picker and only its text is swapped. While there are
          matches the text is empty, so typing does not announce on every key. */}
      <p role="status" aria-live="polite" className="sr-only">
        {open && matches.length === 0 ? t('prices.categoryNoResults') : ''}
      </p>
    </div>
  )
}
