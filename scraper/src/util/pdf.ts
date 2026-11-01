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
// lands on the VPS (deferred to the VPS migration, issue #322). The
// subprocess is also budgeted on both axes (C5: no hung daily job — the
// fetch ladder's AbortSignal.timeout doctrine, applied to the child
// process): a pdftoppm that never exits is SIGKILLed at the render timeout,
// and the page bytes read back from disk are capped, so a stuck or
// pathological document settles as a typed error instead of hanging the
// nightly mid-run (where per-store isolation could not even fire).

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

/**
 * The render subprocess's wall-clock budget, SIGKILL included. Sized on
 * measured evidence, not CI-class hardware (issue #335 probes on the idle
 * 2-vCPU VPS, 2026-11-01): the real 20-page super-hemat brochure renders
 * clean in 134 s at 150 DPI (~6.7 s/page; the rest of the fleet 3–24 s) —
 * the original ~120 s budget SIGKILLed a healthy render. 300 s covers a
 * 40-page brochure at ~7 s/page with load headroom, so only a stuck or
 * pathological process (poppler has a documented history of pathological
 * loops on malformed documents) can hit it. A hang here must never outlive
 * the budget: the Effect settles typed, and the store's per-store isolation
 * takes over.
 */
export const PDF_RENDER_TIMEOUT_MS = 300_000

/**
 * Cumulative cap on the rendered page bytes read back from disk. Sized
 * against the shipped ceiling so it cannot false-positive on a full legal
 * render: maxPages 40 × a 150 DPI legal page (1275×2100 px) whose PNG
 * inflates to at most ~409 MiB even as pure incompressible RGBA —
 * comfortably under the cap — while a crafted huge-page document fails
 * typed instead of exhausting the box's memory.
 */
export const PDF_MAX_OUTPUT_BYTES = 512 * 1024 * 1024

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
 * exit (corrupt PDF) carries poppler's stderr; a subprocess that outlives
 * `timeoutMs` is SIGKILLed and fails typed; page bytes past
 * `maxOutputBytes` cumulative fail typed. Both budgets default to the
 * shipped constants above and are overridable at the seam for tests.
 */
export async function renderWithPdftoppm(
  pdf: Uint8Array,
  opts: {
    dpi: number
    maxPages?: number
    bin?: string
    timeoutMs?: number
    maxOutputBytes?: number
    /** Test seam: the spawn call itself, so the budgets run without a real child. */
    spawnFn?: typeof spawn
  }
): Promise<RenderedPage[]> {
  const bin = opts.bin ?? 'pdftoppm'
  const spawnFn = opts.spawnFn ?? spawn
  const timeoutMs = opts.timeoutMs ?? PDF_RENDER_TIMEOUT_MS
  const maxOutputBytes = opts.maxOutputBytes ?? PDF_MAX_OUTPUT_BYTES
  const dir = await mkdtemp(path.join(tmpdir(), 'rumaq-pdf-'))
  try {
    const input = path.join(dir, 'brochure.pdf')
    await writeFile(input, pdf)
    const args = ['-png', '-r', String(opts.dpi)]
    if (opts.maxPages !== undefined) args.push('-l', String(opts.maxPages))
    args.push(input, path.join(dir, 'page'))
    await new Promise<void>((resolve, reject) => {
      const child = spawnFn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      let timedOut = false
      // C5: no hung daily job — nothing else in this module can hang the
      // nightly, so the child must not either. The timer is cleared on
      // every settling path; after the SIGKILL the later `close` event
      // must not overwrite the timeout rejection (the flag guards it).
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
        reject(
          new PdfRenderError({
            message:
              `${bin} timed out after ${timeoutMs}ms and was killed (SIGKILL) — the document ` +
              `is likely pathological (partial stderr: ${stderr.trim().slice(0, 500)})`,
            cause: stderr,
          })
        )
      }, timeoutMs)
      child.stderr?.on('data', (chunk: Buffer) => {
        // Bounded accumulation: a pathological document can spew stderr for
        // the whole timeout window — only what a diagnostic message needs.
        if (stderr.length < 8192) stderr += chunk.toString()
      })
      child.on('error', (cause) => {
        clearTimeout(timer)
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
        clearTimeout(timer)
        if (timedOut) return // the timeout rejection already settled the promise
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
    // Read back sequentially (not Promise.all) so the output cap bounds
    // peak memory: the loop stops at the first page that crosses it, and
    // the failure is typed — never a silent truncation.
    const pages: RenderedPage[] = []
    let totalBytes = 0
    for (const entry of entries) {
      const bytes = new Uint8Array(await readFile(path.join(dir, entry.name)))
      totalBytes += bytes.byteLength
      if (totalBytes > maxOutputBytes) {
        throw new PdfRenderError({
          message:
            `${bin} rendered ${totalBytes} bytes of page images — past the ` +
            `${maxOutputBytes}-byte output cap; the document is likely pathological`,
        })
      }
      pages.push({ pageNo: entry.pageNo, bytes })
    }
    return pages
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
