// PDF → page-image renderer (issue #322, design-arch §1.2). Indomaret ships
// its weekly brochures as static PDFs; the OCR flow consumes page images, so
// a rasterize step bridges the two. The primitive is poppler's `pdftoppm`
// (poppler-utils) as a system binary — battle-tested, zero Bun/native-module
// risk, deterministic for identical input (novelty keys on the rendered
// bytes' MD5, so determinism is load-bearing) — behind an injectable seam:
// tests inject `render` and never need the binary, and one opt-in live test
// runs the real one when present. util/io.ts / util/retry.ts precedent for
// process/IO seams.
//
// A missing binary is a typed red error naming `pdftoppm`, never a silent
// zero (the same philosophy as the zero-cards sentinel): a deploy that
// cannot render must fail its Indomaret cycle loudly until poppler-utils
// lands on the VPS (deferred to the VPS migration, issue #322).

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Effect } from 'effect'

// The error rides the FetchError union (defined in fetch/errors.ts, the
// single home of the ladder's typed errors) so a render failure reddens the
// store through the same per-store isolation as every fetch error.
import { PdfRenderError } from '../fetch/errors.js'

export { PdfRenderError }

/** One rasterized PDF page, in document order (1-based). */
export interface RenderedPage {
  pageNo: number
  bytes: Uint8Array
}

export interface RenderPdfOptions {
  /** Raster DPI. 150 keeps small price text sharp for OCR (design-arch §1.2). */
  dpi?: number
  /** Render at most this many pages — the maxPages budget clamp. */
  maxPages?: number
  /**
   * The render seam. Defaults to the real `pdftoppm` subprocess; tests
   * inject a fake so the suite never needs the binary.
   */
  render?: (pdf: Uint8Array, opts: { dpi: number; maxPages?: number }) => Promise<RenderedPage[]>
  /**
   * Binary path for the default renderer. Test seam for the missing-binary
   * case; production uses `pdftoppm` from PATH.
   */
  bin?: string
}

/** The shipped DPI — at or above the effective detail of the JPEG pages Gemini already reads well. */
export const PDF_DPI = 150

/**
 * Render `pdf` to page images. The clamp is enforced twice by design: the
 * default renderer passes `maxPages` to `pdftoppm -l` (pages that would be
 * dropped are never rasterized — CPU saved, design-arch §5) and the result
 * is sliced again here, so a renderer that ignores the budget can never
 * blow past it. An empty result is a typed failure, never a silent zero.
 */
export function renderPdfPages(
  pdf: Uint8Array,
  options: RenderPdfOptions = {}
): Effect.Effect<RenderedPage[], PdfRenderError> {
  const render = options.render ?? renderWithPdftoppm
  const dpi = options.dpi ?? PDF_DPI
  return Effect.tryPromise({
    try: () => render(pdf, { dpi, maxPages: options.maxPages }),
    catch: (cause) =>
      cause instanceof PdfRenderError
        ? cause
        : new PdfRenderError({
            message: `PDF render failed: ${String(cause)}`,
            cause,
          }),
  }).pipe(
    Effect.flatMap((pages) => {
      const clamped = options.maxPages !== undefined ? pages.slice(0, options.maxPages) : pages
      if (clamped.length === 0) {
        return Effect.fail(
          new PdfRenderError({
            message: `PDF render produced 0 pages for a ${pdf.byteLength}-byte document`,
          })
        )
      }
      return Effect.succeed(clamped)
    })
  )
}

const PAGE_FILE = /^page-(\d+)\.png$/

/**
 * The real renderer: writes the PDF to a temp dir, spawns
 * `pdftoppm -png -r {dpi} [-l maxPages]`, and reads the page files in page
 * order. The temp dir is removed whatever the outcome. Spawn ENOENT — the
 * binary is absent — is a typed error naming the missing binary; a non-zero
 * exit (corrupt PDF) carries poppler's stderr.
 */
export async function renderWithPdftoppm(
  pdf: Uint8Array,
  opts: { dpi: number; maxPages?: number; bin?: string }
): Promise<RenderedPage[]> {
  const bin = opts.bin ?? 'pdftoppm'
  const dir = await mkdtemp(path.join(tmpdir(), 'rumaq-pdf-'))
  try {
    const input = path.join(dir, 'brochure.pdf')
    await writeFile(input, pdf)
    const args = ['-png', '-r', String(opts.dpi)]
    if (opts.maxPages !== undefined) args.push('-l', String(opts.maxPages))
    args.push(input, path.join(dir, 'page'))
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (cause) => {
        const missing = (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
        reject(
          new PdfRenderError({
            message: missing
              ? `${bin} not found — install poppler-utils to render Indomaret's PDF brochures`
              : `failed to spawn ${bin}: ${String(cause)}`,
            cause,
          })
        )
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(
            new PdfRenderError({
              message: `${bin} exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
              cause: stderr,
            })
          )
        }
      })
    })
    // pdftoppm names pages page-1.png…page-N.png, zero-padding the counter
    // once a document has 10+ pages — sort numerically, never lexically.
    const entries = (await readdir(dir)).flatMap((name) => {
      const match = PAGE_FILE.exec(name)
      return match ? [{ name, pageNo: Number(match[1]) }] : []
    })
    entries.sort((a, b) => a.pageNo - b.pageNo)
    return await Promise.all(
      entries.map(async (entry) => ({
        pageNo: entry.pageNo,
        bytes: new Uint8Array(await readFile(path.join(dir, entry.name))),
      }))
    )
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
