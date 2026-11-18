import { describe, it, expect, vi } from 'vite-plus/test'
import { render, fireEvent, screen, within } from '@testing-library/react'
import React, { useState } from 'react'
import { CategoryPicker } from './CategoryPicker.jsx'

// Issue #632: the single searchable category control that replaced the wall
// of ~49 taxonomy chips. These tests pin the picker contract on its own: the
// trigger label, the pinned reset row, case-insensitive search, selection and
// clearing (null), the combobox/listbox wiring, and the keyboard/focus model.
// Integration with the Prices query lives in Prices.test.jsx.
const CATEGORIES = [
  'beras',
  'minyak-goreng',
  'gula-pasir',
  'telur',
  'susu',
  'kopi',
  'teh',
  'sabun',
  'deterjen',
]

function Harness({ initial = null, onChange = () => {} }) {
  const [value, setValue] = useState(initial)
  return React.createElement(CategoryPicker, {
    categories: CATEGORIES,
    value,
    onChange: (next) => {
      setValue(next)
      onChange(next)
    },
  })
}

function renderPicker(options = {}) {
  const onChange = options.onChange ?? vi.fn()
  const utils = render(React.createElement(Harness, { ...options, onChange }))
  return { ...utils, onChange }
}

function trigger(container) {
  return container.querySelector('[data-testid="category-picker"] > button')
}

function searchInput() {
  return screen.getByRole('combobox', { name: 'prices.categorySearchPlaceholder' })
}

function optionNames() {
  return screen.getAllByRole('option').map((option) => option.textContent)
}

function openPicker(container) {
  fireEvent.click(trigger(container))
  return screen.getByRole('listbox')
}

describe('CategoryPicker', () => {
  it('starts closed with the All categories trigger', () => {
    const { container } = renderPicker()
    const button = trigger(container)
    expect(button.textContent).toContain('prices.allCategories')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-haspopup')).toBe('listbox')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens a searchable listbox with All categories pinned first', () => {
    const { container } = renderPicker()
    const button = trigger(container)
    fireEvent.click(button)

    const listbox = screen.getByRole('listbox')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(listbox.id)

    // All categories + one row per taxonomy slug, in meta order.
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(CATEGORIES.length + 1)
    expect(options[0].textContent).toBe('prices.allCategories')
    expect(options.slice(1).map((option) => option.textContent)).toEqual(CATEGORIES)
    // The search field owns focus and labels the panel for screen readers.
    expect(document.activeElement).toBe(searchInput())
    expect(listbox.getAttribute('aria-label')).toBe('prices.categoryFilterLabel')
  })

  it('filters the slugs case-insensitively and keeps the reset row', () => {
    const { container } = renderPicker()
    openPicker(container)
    fireEvent.change(searchInput(), { target: { value: 'BERAS' } })

    expect(optionNames()).toEqual(['prices.allCategories', 'beras'])
  })

  it('keeps the status region mounted and silent while matches exist', () => {
    const { container } = renderPicker()
    // #641: the live region must already be in the DOM before its text is
    // set, otherwise screen readers miss the announcement.
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')

    openPicker(container)
    fireEvent.change(searchInput(), { target: { value: 'ber' } })
    expect(status.textContent).toBe('')

    fireEvent.change(searchInput(), { target: { value: '' } })
    expect(status.textContent).toBe('')
  })

  it('swaps the mounted status region to the no-results message', () => {
    const { container } = renderPicker()
    const status = screen.getByRole('status')
    openPicker(container)
    fireEvent.change(searchInput(), { target: { value: 'tidak-ada' } })

    expect(optionNames()).toEqual(['prices.allCategories'])
    // Same node, new text — not a freshly mounted live region.
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('prices.categoryNoResults')
    // The visible no-results styling stays for sighted users; the mounted
    // region above owns the announcement.
    expect(
      screen.getByText('prices.categoryNoResults', { selector: 'p[aria-hidden="true"]' })
    ).toBeTruthy()
  })

  it('clears the search text with the clear button', () => {
    const { container } = renderPicker()
    openPicker(container)
    fireEvent.change(searchInput(), { target: { value: 'ber' } })
    fireEvent.click(screen.getByRole('button', { name: 'prices.categorySearchClear' }))

    expect(searchInput().value).toBe('')
    expect(screen.getAllByRole('option')).toHaveLength(CATEGORIES.length + 1)
  })

  it('selects a category, closes the panel and returns focus to the trigger', () => {
    const { container, onChange } = renderPicker()
    openPicker(container)
    fireEvent.click(screen.getByRole('option', { name: 'beras' }))

    expect(onChange).toHaveBeenCalledWith('beras')
    expect(screen.queryByRole('listbox')).toBeNull()
    const button = trigger(container)
    expect(button.textContent).toContain('beras')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button)
  })

  it('checks and highlights the active category on open', () => {
    const { container } = renderPicker({ initial: 'minyak-goreng' })
    expect(trigger(container).textContent).toContain('minyak-goreng')
    openPicker(container)

    const selected = screen.getByRole('option', { name: 'minyak-goreng' })
    expect(selected.getAttribute('aria-selected')).toBe('true')
    expect(selected.querySelector('svg')).toBeTruthy()
    const all = screen.getByRole('option', { name: 'prices.allCategories' })
    expect(all.getAttribute('aria-selected')).toBe('false')
    expect(all.querySelector('svg')).toBeNull()
  })

  it('clears the filter through the All categories row', () => {
    const { container, onChange } = renderPicker({ initial: 'beras' })
    openPicker(container)
    fireEvent.click(screen.getByRole('option', { name: 'prices.allCategories' }))

    expect(onChange).toHaveBeenCalledWith(null)
    expect(trigger(container).textContent).toContain('prices.allCategories')
  })

  it('moves with the arrow keys and selects with Enter', () => {
    const { container, onChange } = renderPicker()
    const button = trigger(container)
    // ArrowDown on the trigger opens the panel, like a combobox.
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    const input = searchInput()

    // Opens on the pinned reset row; the first arrow lands on the first slug.
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      'prices.allCategories'
    )
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      'beras'
    )
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      'minyak-goreng'
    )
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      'beras'
    )
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('beras')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('wraps the keyboard navigation at both ends', () => {
    const { container } = renderPicker({ initial: 'deterjen' })
    openPicker(container)
    const input = searchInput()
    // Opens on the selected row (last in the list).
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      'deterjen'
    )
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      'prices.allCategories'
    )
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      'deterjen'
    )
  })

  it('closes with Escape and returns focus to the trigger', () => {
    const { container } = renderPicker()
    openPicker(container)
    fireEvent.keyDown(searchInput(), { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    const button = trigger(container)
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes with the panel close button', () => {
    const { container } = renderPicker()
    openPicker(container)
    fireEvent.click(screen.getByRole('button', { name: 'prices.categoryClose' }))

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger(container))
  })

  it('closes on a click outside without stealing focus back', () => {
    const { container } = renderPicker()
    openPicker(container)
    fireEvent.mouseDown(document.body)

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).not.toBe(trigger(container))
  })

  it('toggles closed when the trigger is clicked again', () => {
    const { container } = renderPicker()
    const button = trigger(container)
    fireEvent.click(button)
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).not.toHaveLength(0)
    fireEvent.click(button)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

// #728: the override form's additive variant — no reset row (an override must
// NAME a slug; null is not a legal value) and per-surface copy. The defaults
// above prove the ProductsView behavior is untouched; this block pins the
// additive props alone.
describe('CategoryPicker — override variant (additive props)', () => {
  function Harness({ categories = CATEGORIES, ...props }) {
    const [value, setValue] = useState(null)
    return React.createElement(CategoryPicker, {
      categories,
      value,
      onChange: setValue,
      ...props,
    })
  }

  function renderOverride(options = {}) {
    return render(React.createElement(Harness, { ...options }))
  }

  it('omits the All categories reset row and offers no null option', () => {
    const { container } = renderOverride({ resetOption: false })
    fireEvent.click(trigger(container))

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(CATEGORIES.length)
    expect(options.map((option) => option.textContent)).toEqual(CATEGORIES)
    // Selecting the first row reports a slug, never null.
    fireEvent.click(options[0])
    expect(container.querySelector('[data-testid="category-picker"]').textContent).toContain(
      CATEGORIES[0]
    )
  })

  it('keeps keyboard navigation consistent without the reset row', () => {
    const { container } = renderOverride({ resetOption: false })
    fireEvent.keyDown(trigger(container), { key: 'ArrowDown' })
    const input = screen.getByRole('combobox')

    // No reset row above: Home is the first slug, and ArrowUp from it wraps
    // to the last slug (the offset the pinned row used to add is gone).
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      CATEGORIES[0]
    )
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      CATEGORIES[CATEGORIES.length - 1]
    )
    fireEvent.keyDown(input, { key: 'Home' })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toBe(
      CATEGORIES[0]
    )
  })

  it('speaks the override labels instead of the prices filter copy', () => {
    const { container } = renderOverride({
      resetOption: false,
      labels: {
        prefix: 'override.pickerPrefix',
        all: 'override.pickPlaceholder',
        close: 'override.pickerClose',
        searchPlaceholder: 'override.pickerSearch',
        searchClear: 'override.pickerClear',
        noResults: 'override.pickerNoResults',
        listboxLabel: 'override.pickerListbox',
      },
    })
    const button = trigger(container)
    // The null-value label doubles as the override's pick placeholder.
    expect(button.textContent).toContain('override.pickPlaceholder')

    fireEvent.click(button)
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('override.pickerListbox')
    expect(screen.getByRole('combobox').getAttribute('aria-label')).toBe('override.pickerSearch')
    expect(screen.getByRole('button', { name: 'override.pickerClose' })).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tidak-ada' } })
    expect(screen.getByRole('status').textContent).toBe('override.pickerNoResults')
  })

  it('falls back per key: a partial labels object keeps the defaults for the rest', () => {
    const { container } = renderOverride({ labels: { prefix: 'override.pickerPrefix' } })
    const button = trigger(container)
    expect(button.textContent).toContain('prices.allCategories')
    fireEvent.click(button)
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe(
      'prices.categoryFilterLabel'
    )
    // The panel header prefix took the override.
    expect(container.textContent).toContain('override.pickerPrefix')
  })
})
