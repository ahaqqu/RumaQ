import { describe, it, expect } from 'vite-plus/test'
import { plainParseSearch, plainStringifySearch } from './plainSearchParams.js'

// #716 regression pins: the TanStack defaults JSON-round-trip search values
// (?admin=true → boolean, ?date=20261118 → number, resolved strings
// re-serialized as %22quoted%22), which broke the /brochures/view
// byte-exact brochure_url contract. These helpers must keep every value a
// plain string and serialize without quoting.
describe('plainParseSearch', () => {
  it('keeps every value a string — no boolean or numeric coercion', () => {
    const query = plainParseSearch('?store=lotte-mart&date=20261118&file=page_1.jpg&admin=true')
    expect(query).toEqual({
      store: 'lotte-mart',
      date: '20261118',
      file: 'page_1.jpg',
      admin: 'true',
    })
    expect(query.date).toBe('20261118')
    expect(query.admin).toBe('true')
  })

  it('decodes percent-escapes into plain strings', () => {
    expect(plainParseSearch('file=page%282%29.jpg').file).toBe('page(2).jpg')
  })

  it('collapses repeated keys to an array (qss parity)', () => {
    expect(plainParseSearch('tag=a&tag=b')).toEqual({ tag: ['a', 'b'] })
  })

  it('maps a bare key to the empty string', () => {
    expect(plainParseSearch('store').store).toBe('')
  })
})

describe('plainStringifySearch', () => {
  it('serializes the viewer deep link byte-exactly — no %22 quoting', () => {
    expect(
      plainStringifySearch({
        store: 'lotte-mart',
        date: '20261118',
        file: 'page_1.jpg',
        admin: 'true',
      })
    ).toBe('?store=lotte-mart&date=20261118&file=page_1.jpg&admin=true')
  })

  it("drops undefined values (validateSearch's unknown-segment rule)", () => {
    expect(plainStringifySearch({ store: 'lotte-mart', admin: undefined })).toBe(
      '?store=lotte-mart'
    )
  })

  it('round-trips through parse symmetrically', () => {
    const search = { store: 'lotte-mart', date: '20261118', file: 'page_1.jpg', admin: 'true' }
    expect(plainParseSearch(plainStringifySearch(search))).toEqual(search)
  })

  it('renders no search at all for an empty resolved object', () => {
    expect(plainStringifySearch({})).toBe('')
  })
})
