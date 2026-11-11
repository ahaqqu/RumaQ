import { describe, it, expect } from 'vite-plus/test'
import { brandSuffix, prettyName, prettyUnit } from './productDisplay.js'

describe('prettyName', () => {
  it('title-cases long uppercase words and keeps short acronyms (issue #633)', () => {
    expect(prettyName('MANGGA HARUM MANIS BINTANG')).toBe('Mangga Harum Manis Bintang')
    expect(prettyName('ABC KACANG')).toBe('ABC Kacang')
    expect(prettyName('SALAK PONDOH')).toBe('Salak Pondoh')
    expect(prettyName('ABC SGM UHT RON XL')).toBe('ABC SGM UHT RON XL')
  })

  it('title-cases lowercase words in an ordinary mixed-case name', () => {
    expect(prettyName('Buah naga merah')).toBe('Buah Naga Merah')
    expect(prettyName('buah naga merah')).toBe('Buah Naga Merah')
    expect(prettyName('MANGGA Harum Manis')).toBe('Mangga Harum Manis')
  })

  it('preserves mixed-case and digit/punctuation-bearing tokens', () => {
    expect(prettyName('iPhone 15 Pro')).toBe('iPhone 15 Pro')
    expect(prettyName('MR.P SUSU')).toBe('MR.P Susu')
    expect(prettyName('SAMSUNG Galaxy S24')).toBe('Samsung Galaxy S24')
  })

  it('collapses whitespace', () => {
    expect(prettyName('  MANGGA   HARUM  MANIS  ')).toBe('Mangga Harum Manis')
    expect(prettyName('  ')).toBe('')
    expect(prettyName(null)).toBe('')
    expect(prettyName(undefined)).toBe('')
  })

  it('normalizes size tokens inside names', () => {
    expect(prettyName('CARNATION Kental Manis 6×38g')).toBe('Carnation Kental Manis 6 × 38 g')
    expect(prettyName('RON 88 Spring 300ml')).toBe('RON 88 Spring 300 ml')
    expect(prettyName('Minyak Goreng 1.5L')).toBe('Minyak Goreng 1.5 L')
  })
})

describe('prettyUnit', () => {
  it('spaces and canonicalizes metric sizes', () => {
    expect(prettyUnit('300ml')).toBe('300 ml')
    expect(prettyUnit('6×38g')).toBe('6 × 38 g')
    expect(prettyUnit('6 x 45 ml')).toBe('6 × 45 ml')
    expect(prettyUnit('1.5L')).toBe('1.5 L')
    expect(prettyUnit('100gr')).toBe('100 g')
    expect(prettyUnit('1KG')).toBe('1 kg')
  })

  it('spaces package counts without changing the unit word', () => {
    expect(prettyUnit('2pcs')).toBe('2 pcs')
    expect(prettyUnit('2 pcs')).toBe('2 pcs')
    expect(prettyUnit('2buah')).toBe('2 buah')
    expect(prettyUnit('1pack')).toBe('1 pack')
    expect(prettyUnit('2sachet')).toBe('2 sachet')
    expect(prettyUnit('2 packs')).toBe('2 packs')
    expect(prettyUnit('2 sachets')).toBe('2 sachets')
    expect(prettyUnit('2pc')).toBe('2 pc')
  })

  it('normalizes a multiplication sign between quantities or after a size', () => {
    expect(prettyUnit('1 L x 6')).toBe('1 L × 6')
    expect(prettyUnit('12 x 250ml')).toBe('12 × 250 ml')
    expect(prettyUnit('1kg x 12')).toBe('1 kg × 12')
  })

  it('leaves non-size text alone', () => {
    expect(prettyUnit('Spring')).toBe('Spring')
    expect(prettyUnit('RON 88')).toBe('RON 88')
    expect(prettyUnit('pack')).toBe('pack')
    expect(prettyUnit('')).toBe('')
    expect(prettyUnit(null)).toBe('')
  })
})

describe('brandSuffix', () => {
  it('suppresses a brand already present as whole words (case/punctuation-insensitive)', () => {
    expect(brandSuffix('RON 88 Spring 300ml', 'RON 88')).toBe('')
    expect(brandSuffix('RON-88 Spring 300ml', 'RON 88')).toBe('')
    expect(brandSuffix('RON88 Spring 300ml', 'RON 88')).toBe('')
    expect(brandSuffix('RON 88 Spring 300ml', 'RON-88')).toBe('')
    expect(brandSuffix('RON 88 Spring 300ml', 'RON88')).toBe('')
    expect(brandSuffix('CARNATION Kental Manis 6×38g', 'CARNATION')).toBe('')
    expect(brandSuffix('Minyak Goreng Bimoli', 'bimoli')).toBe('')
    expect(brandSuffix('ABC KACANG', 'A.B.C')).toBe('')
    expect(brandSuffix('A.B.C KACANG', 'ABC')).toBe('')
    expect(brandSuffix('ABC Kacang', 'ABC')).toBe('')
    expect(brandSuffix('MR.P Special', 'MRP')).toBe('')
    expect(brandSuffix('MRP Special', 'MR.P')).toBe('')
  })

  it('appends a brand that only occurs inside a longer word (#636)', () => {
    // Substring, not a word: the old alphanumeric comparison dropped these
    // brands even though the name never shows them.
    expect(brandSuffix('Sariwangi', 'Sari')).toBe(' · Sari')
    expect(brandSuffix('Roman', 'Roma')).toBe(' · Roma')
    expect(brandSuffix('Indomie', 'Ina')).toBe(' · Ina')
    expect(brandSuffix('Gulaku', 'Gula')).toBe(' · Gula')
    expect(brandSuffix('Gula Pasir', 'Gulaku')).toBe(' · Gulaku')
  })

  it('appends short brands missing from the name (#636)', () => {
    expect(brandSuffix('Minyak Goreng', 'XL')).toBe(' · XL')
    expect(brandSuffix('Minyak Goreng', '3M')).toBe(' · 3M')
    expect(brandSuffix('Minyak Goreng', 'A B')).toBe(' · A B')
    expect(brandSuffix('Minyak Goreng', 'AB')).toBe(' · AB')
  })

  it('appends a pretty-cased brand when the name does not contain it', () => {
    expect(brandSuffix('Minyak Goreng', 'Bimoli')).toBe(' · Bimoli')
    expect(brandSuffix('Gula Pasir', 'CARNATION')).toBe(' · Carnation')
    expect(brandSuffix('Gula Pasir', 'BIMOLI 1L')).toBe(' · Bimoli 1 L')
    expect(brandSuffix('Minyak Goreng', 'ABC')).toBe(' · ABC')
  })

  it('skips empty brands', () => {
    expect(brandSuffix('Minyak Goreng', null)).toBe('')
    expect(brandSuffix('Minyak Goreng', '')).toBe('')
    expect(brandSuffix('Minyak Goreng', '   ')).toBe('')
    // A brand with no letters or digits is not a brand — never " · -".
    expect(brandSuffix('Minyak Goreng', '-')).toBe('')
    expect(brandSuffix('Minyak Goreng', '!!!')).toBe('')
  })
})
