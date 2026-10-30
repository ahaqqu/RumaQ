// renderPdfPages tests (issue #322, design-arch §1.2) — the injectable seam
// (injected render, page ordering, budget clamp, zero-page sentinel) plus
// opt-in live tests of the real pdftoppm on the tiny fixture PDF, skipped
// where the binary is absent (CI-safe).

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'

import { PdfRenderError } from '../../src/fetch/errors.js'
import { md5Hash } from '../../src/fetch/state.js'
import { PDF_DPI, renderPdfPages, renderWithPdftoppm } from '../../src/util/pdf.js'
import { exitError } from '../helpers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadFixturePdf(): Uint8Array {
  return new Uint8Array(readFileSync(path.join(__dirname, '../fixtures/indomaret/sample.pdf')))
}

describe('renderPdfPages — injected seam', () => {
  it('passes the pdf bytes, dpi, and budget to the injected render', async () => {
    const pdf = loadFixturePdf()
    const seen: { byteLength: number; dpi: number; maxPages?: number }[] = []
    const pages = await Effect.runPromise(
      renderPdfPages(pdf, {
        dpi: 100,
        maxPages: 3,
        render: async (bytes, opts) => {
          seen.push({ byteLength: bytes.byteLength, dpi: opts.dpi, maxPages: opts.maxPages })
          return [
            { pageNo: 1, bytes: new Uint8Array([1]) },
            { pageNo: 2, bytes: new Uint8Array([2]) },
          ]
        },
      })
    )
    expect(seen).toEqual([{ byteLength: pdf.byteLength, dpi: 100, maxPages: 3 }])
    expect(pages.map((page) => page.pageNo)).toEqual([1, 2])
  })

  it('defaults to 150 DPI and slices a renderer that ignores the budget clamp', async () => {
    const pages = await Effect.runPromise(
      renderPdfPages(new Uint8Array(8), {
        maxPages: 2,
        render: async () => [
          { pageNo: 1, bytes: new Uint8Array([1]) },
          { pageNo: 2, bytes: new Uint8Array([2]) },
          { pageNo: 3, bytes: new Uint8Array([3]) },
          { pageNo: 4, bytes: new Uint8Array([4]) },
        ],
      })
    )
    expect(pages.map((page) => page.pageNo)).toEqual([1, 2])
    // The shipped DPI is the store-level constant.
    expect(PDF_DPI).toBe(150)
  })

  it('fails a zero-page render as a typed error — never a silent zero', async () => {
    const exit = await Effect.runPromiseExit(
      renderPdfPages(new Uint8Array(8), { render: async () => [] })
    )
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as PdfRenderError
    expect(error._tag).toBe('PdfRenderError')
    expect(error.message).toContain('0 pages')
  })

  it('wraps a non-PdfRenderError rejection into the typed error', async () => {
    const exit = await Effect.runPromiseExit(
      renderPdfPages(new Uint8Array(8), {
        render: async () => {
          throw new Error('disk full')
        },
      })
    )
    const error = exitError(exit) as PdfRenderError
    expect(error._tag).toBe('PdfRenderError')
    expect(error.message).toContain('disk full')
  })
})

// Live tests: the real binary on the tiny 2-page fixture PDF. Skipped where
// pdftoppm is absent (CI) — the seam tests above carry the behavior.
const hasPdftoppm = spawnSync('pdftoppm', ['-v']).status !== null

describe.skipIf(!hasPdftoppm)('renderPdfPages — live pdftoppm', () => {
  it('renders the 2-page fixture in order at the requested DPI', async () => {
    const pages = await Effect.runPromise(
      renderPdfPages(loadFixturePdf(), { dpi: 72, maxPages: 5 })
    )
    expect(pages.map((page) => page.pageNo)).toEqual([1, 2])
    for (const page of pages) {
      // PNG magic — the bytes are real images, ready for the OCR flow.
      expect([...page.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    }
  })

  it('is deterministic for identical input — novelty keys on the rendered bytes', async () => {
    const pdf = loadFixturePdf()
    const first = await Effect.runPromise(renderPdfPages(pdf, { dpi: 72 }))
    const second = await Effect.runPromise(renderPdfPages(pdf, { dpi: 72 }))
    expect(first.map((page) => md5Hash(page.bytes))).toEqual(
      second.map((page) => md5Hash(page.bytes))
    )
  })

  it('honors the budget via pdftoppm -l (dropped pages are never rasterized)', async () => {
    const pages = await Effect.runPromise(
      renderPdfPages(loadFixturePdf(), { dpi: 72, maxPages: 1 })
    )
    expect(pages).toHaveLength(1)
    expect(pages[0]!.pageNo).toBe(1)
  })

  it('fails a corrupt document as a typed error', async () => {
    const exit = await Effect.runPromiseExit(
      renderPdfPages(new TextEncoder().encode('this is not a pdf at all'))
    )
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as PdfRenderError
    expect(error._tag).toBe('PdfRenderError')
    expect(error.message).toContain('pdftoppm')
  })
})

describe('renderWithPdftoppm — missing binary', () => {
  it('fails with a typed error naming the missing binary (owner directive: never a silent zero)', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () =>
          renderWithPdftoppm(loadFixturePdf(), {
            dpi: 150,
            bin: '/nonexistent/pdftoppm-for-tests',
          }),
        catch: (cause) => cause as PdfRenderError,
      })
    )
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as PdfRenderError
    expect(error._tag).toBe('PdfRenderError')
    expect(error.message).toContain('/nonexistent/pdftoppm-for-tests')
    expect(error.message).toContain('not found')
  })
})
