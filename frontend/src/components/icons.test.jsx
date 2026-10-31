import { describe, it, expect } from 'vite-plus/test'
import { render } from '@testing-library/react'
import React from 'react'
import {
  IconHome,
  IconBox,
  IconPlan,
  IconHistory,
  IconSettings,
  IconReceipt,
  IconSpark,
  IconSearch,
  IconCamera,
  IconUpload,
  IconClose,
  IconCheck,
  IconPin,
  IconClock,
  IconShop,
  IconBolt,
  IconLeaf,
  IconKey,
  IconTrash,
  IconRefresh,
  BrandMark,
} from './icons.jsx'

describe('icons', () => {
  const icons = [
    IconHome,
    IconBox,
    IconPlan,
    IconHistory,
    IconSettings,
    IconReceipt,
    IconSpark,
    IconSearch,
    IconCamera,
    IconUpload,
    IconClose,
    IconCheck,
    IconPin,
    IconClock,
    IconShop,
    IconBolt,
    IconLeaf,
    IconKey,
    IconTrash,
    IconRefresh,
  ]

  for (const Icon of icons) {
    it(`renders ${Icon.name || 'Icon'} without error`, () => {
      const { container } = render(React.createElement(Icon))
      expect(container.querySelector('svg')).toBeTruthy()
    })
  }

  it('IconHome accepts size prop', () => {
    const { container } = render(React.createElement(IconHome, { size: 32 }))
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('32')
  })

  it('renders BrandMark', () => {
    const { container } = render(React.createElement(BrandMark))
    // Brand tile: green rounded square with a white sprout glyph inside.
    expect(container.firstElementChild.tagName).toBe('DIV')
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('BrandMark accepts size prop', () => {
    const { container } = render(React.createElement(BrandMark, { size: 48 }))
    const tile = container.firstElementChild
    expect(tile.style.width).toBe('48px')
    expect(tile.style.height).toBe('48px')
  })
})
