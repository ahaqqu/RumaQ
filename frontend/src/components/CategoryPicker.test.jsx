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

  it('shows a no-results state when no slug matches', () => {
    const { container } = renderPicker()
    openPicker(container)
    fireEvent.change(searchInput(), { target: { value: 'tidak-ada' } })

    expect(optionNames()).toEqual(['prices.allCategories'])
    expect(screen.getByRole('status').textContent).toBe('prices.categoryNoResults')
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
