// renderPdfPages tests (issue #322, design-arch §1.2) — the injectable seam
// (injected render, page ordering, budget clamp, zero-page sentinel) plus
// opt-in live tests of the real pdftoppm on the tiny fixture PDF, skipped
// where the binary is absent (CI installs poppler-utils, so the live block
// runs there too). The subprocess budgets (A1: no hung daily job) are
// tested through the spawn seam — a fake child process, never a real
// long-running process.

import { spawnSync, type ChildProcess, type spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vite-plus/test'
import { EventEmitter } from 'node:events'
import { Effect } from 'effect'

import { PdfRenderError } from '../../src/fetch/errors.js'
import { md5Hash } from '../../src/fetch/state.js'
import {
  PDF_DPI,
  PDF_MAX_OUTPUT_BYTES,
  PDF_RENDER_TIMEOUT_MS,
  renderPdfPages,
  renderWithPdftoppm,
} from '../../src/util/pdf.js'
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

// The subprocess budgets (A1: a stuck or pathological PDF must settle the
// Effect typed, never hang the nightly past per-store isolation's reach).
// Both run through the spawn seam — a fake ChildProcess, so no test ever
// waits on a real long-running process.
describe('renderWithPdftoppm — subprocess budgets', () => {
  /** A fake pdftoppm child: stderr pipe + event surface, kill spied. */
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter | null
      kill: (signal?: string) => boolean
    }
    child.stderr = new EventEmitter()
    const kill = vi.fn(() => true)
    child.kill = kill
    return { child: child as unknown as ChildProcess, kill }
  }

  it('ships budgets sized for the workload: generous timeout, cap above a full legal render', () => {
    // 300 s covers the measured worst case on the 2-vCPU box (a real 20-page
    // brochure rendered clean in 134 s at 150 DPI, ~6.7 s/page — issue #335
    // probes); the byte cap sits above the ~409 MiB worst case (40
    // incompressible RGBA legal pages) so it can only trip on a pathological
    // document.
    expect(PDF_RENDER_TIMEOUT_MS).toBe(300_000)
    expect(PDF_MAX_OUTPUT_BYTES).toBe(512 * 1024 * 1024)
  })

  it('kills a stuck pdftoppm at the timeout and fails typed with the partial stderr', async () => {
    const { child, kill } = fakeChild()
    const spawnFn = vi.fn(() => {
      // Deferred one tick: the implementation attaches its stderr handler
      // right after spawnFn returns.
      setTimeout(() => child.stderr!.emit('data', Buffer.from('Syntax Error: page loop')), 0)
      return child // never emits close — the stuck-process case
    }) as unknown as typeof spawn
    const exit = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () => renderWithPdftoppm(loadFixturePdf(), { dpi: 72, timeoutMs: 25, spawnFn }),
        catch: (cause) => cause as PdfRenderError,
      })
    )
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as PdfRenderError
    expect(error._tag).toBe('PdfRenderError')
    expect(error.message).toContain('timed out after 25ms')
    expect(error.message).toContain('SIGKILL')
    expect(error.message).toContain('page loop')
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('fails typed when the cumulative rendered bytes pass the output cap', async () => {
    const { child } = fakeChild()
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      // The page prefix is the spawn's last argument — write two 700 KiB
      // pages there, then exit 0. The reader must stop at the 1 MiB cap.
      const prefix = args.at(-1)!
      void Promise.all([
        writeFile(`${prefix}-1.png`, Buffer.alloc(700 * 1024, 1)),
        writeFile(`${prefix}-2.png`, Buffer.alloc(700 * 1024, 2)),
      ]).then(() => child.emit('close', 0))
      return child
    }) as unknown as typeof spawn
    const exit = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () =>
          renderWithPdftoppm(loadFixturePdf(), { dpi: 72, maxOutputBytes: 1024 * 1024, spawnFn }),
        catch: (cause) => cause as PdfRenderError,
      })
    )
    expect(exit._tag).toBe('Failure')
    const error = exitError(exit) as PdfRenderError
    expect(error._tag).toBe('PdfRenderError')
    expect(error.message).toContain('output cap')
    expect(error.message).toContain('1433600') // 2 × 700 KiB actually rendered
  })

  it('renders pages under the cap in order — a full legitimate render never trips it', async () => {
    const { child } = fakeChild()
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      const prefix = args.at(-1)!
      void Promise.all([
        writeFile(`${prefix}-1.png`, Buffer.alloc(100 * 1024, 1)),
        writeFile(`${prefix}-2.png`, Buffer.alloc(100 * 1024, 2)),
      ]).then(() => child.emit('close', 0))
      return child
    }) as unknown as typeof spawn
    const pages = await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          renderWithPdftoppm(loadFixturePdf(), { dpi: 72, maxOutputBytes: 1024 * 1024, spawnFn }),
        catch: (cause) => cause as PdfRenderError,
      })
    )
    expect(pages.map((page) => page.pageNo)).toEqual([1, 2])
    expect(pages[0]!.bytes[0]).toBe(1)
    expect(pages[1]!.bytes[0]).toBe(2)
  })
})
