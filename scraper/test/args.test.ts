// CLI argument parsing tests — parseArgs was extracted from main.ts so the
// --stores rules are unit-testable without running the pipeline.

import { describe, expect, it } from 'vite-plus/test'

import { parseArgs } from '../src/args.js'

describe('parseArgs --stores (docs/plan/scrape-now.md §2)', () => {
  it('parses a comma list, trims, and dedupes', () => {
    const args = parseArgs(['--publish', '--stores=superindo, astro,superindo'])
    expect(args.stores).toEqual(['superindo', 'astro'])
    expect(args.storesError).toBeUndefined()
    expect(args.publish).toBe(true)
  })

  it('accepts every contract slug (indomaret included)', () => {
    const args = parseArgs(['--stores=superindo,lotte-mart,astro,hypermart,indomaret'])
    expect(args.stores).toEqual(['superindo', 'lotte-mart', 'astro', 'hypermart', 'indomaret'])
  })

  it('rejects an unknown slug with the known list in the error', () => {
    const args = parseArgs(['--stores=superindo,tokopedia'])
    expect(args.stores).toBeUndefined()
    expect(args.storesError).toContain('tokopedia')
    expect(args.storesError).toContain('superindo')
  })

  it('rejects an empty slug list', () => {
    const args = parseArgs(['--stores='])
    expect(args.stores).toBeUndefined()
    expect(args.storesError).toContain('at least one store slug')
  })

  it('leaves stores unset when the flag is absent (the nightly)', () => {
    const args = parseArgs([])
    expect(args.stores).toBeUndefined()
    expect(args.storesError).toBeUndefined()
  })

  it('keeps the pre-existing flags working', () => {
    const args = parseArgs(['--self-check', '--state-dir=/srv/state'], { RUMAQ_PUBLISH: '1' })
    expect(args.selfCheck).toBe(true)
    expect(args.stateDir).toBe('/srv/state')
    expect(args.publish).toBe(true)
  })
})
