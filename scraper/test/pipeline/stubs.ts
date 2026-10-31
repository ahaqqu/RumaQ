// Shared stubs for the pipeline-level test files (pipeline.test.ts and the
// per-store E2E stories in test/pipeline/*.test.ts — review B1): the minimal
// working indomaret chain every scenario rides, the deterministic Gemini
// stubs, and the live-publish capture. Lives outside any test module so the
// stories import it without importing a test file.

import { Effect } from 'effect'

import type { IngestPayload, RunReport } from '@rumaq/contract'

import type { EmbeddingClient } from '../../src/match/embedding.js'
import type { GeminiClient } from '../../src/ocr/gemini.js'
import { fakeBrowserLauncher } from '../helpers.js'

export const noSleep = async () => {}

// Lotte rides the Tier-2 ladder in every pipeline run now; by default its
// listing page yields no promo images so the scoped scenarios stay focused.
export const emptyLotte = fakeBrowserLauncher('<html><body></body></html>')

// Indomaret rides every unscoped run now (issue #322). Its zero-brochure
// sentinel means an empty hub would redden any scenario that doesn't care
// about it, so scenarios get this minimal working chain — one brochure →
// detail with a pdfUrl → a tiny PDF — rendered by a stub into a page that
// the novelty gates SKIP (under 50 KB): the store runs, stays green, and
// contributes nothing, without a poppler dependency in CI.
export const INDOMARET_HUB_URL = 'https://www.indomaret.co.id/promosi/'
export const INDOMARET_PDF_URL = 'https://www.indomaret.co.id/wp-content/uploads/Fixture-29Okt.pdf'
const indomaretHubHtml =
  '<html><body><script>window.open("/paling-murah/", "_blank");</script></body></html>'
const indomaretDetailHtml =
  '<html><body><script>var flipbookOptions_0_x = ' +
  '{"pdfUrl":"https:\\/\\/www.indomaret.co.id\\/wp-content\\/uploads\\/Fixture-29Okt.pdf"};' +
  '</script></body></html>'
const indomaretPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
export const silentIndomaretRender = () =>
  Effect.succeed([{ pageNo: 1, bytes: new Uint8Array(1024) }])

/**
 * The three indomaret branches every scenario fetch mock needs, in order.
 * The fallback mock may be sync or async (scopedOptions wraps async
 * pipeline fetch mocks with this), so the result mirrors its return.
 */
export function serveIndomaret(
  url: string,
  mock: () => Response | Promise<Response>
): Response | Promise<Response> {
  if (url === INDOMARET_HUB_URL) return new Response(indomaretHubHtml, { status: 200 })
  if (url === INDOMARET_PDF_URL) {
    return new Response(indomaretPdf, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })
  }
  if (url.includes('indomaret.co.id')) return new Response(indomaretDetailHtml, { status: 200 })
  return mock()
}

// Deterministic Gemini stubs — a dev machine with GEMINI_API_KEY in the
// environment must never make the test suite call the real API.
export const stubEmbedClient: EmbeddingClient = {
  models: {
    embedContent: async () => ({ embeddings: [{ values: [1, 0] }] }),
  },
}
export const stubVerifyClient: GeminiClient = {
  models: { generateContent: async () => ({ text: 'YES' }) },
}

export const ocrItems = [
  {
    name: 'Gula Pasir',
    brand: null,
    unit: '1 kg',
    price: 17000,
    promo: null,
    period: '22 - 28 Okt 2026',
  },
  { name: 'B', brand: null, unit: null, price: 5000, promo: null, period: null }, // name_too_short
]

/** Live-publish fetch capturing run reports and price payloads; all accepted. */
export function makeReportCapture() {
  const reported: RunReport[] = []
  const posted: IngestPayload[] = []
  return {
    reported,
    posted,
    publishFetch: async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/internal/ingest/runs')) {
        reported.push(JSON.parse(init!.body as string))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      // Brochure image PUTs (issue #293) are accepted, never captured — the
      // body is bytes, not JSON.
      if (url.includes('/api/internal/brochures/')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      posted.push(JSON.parse(init!.body as string))
      return new Response(JSON.stringify({ accepted: 7, skipped: 0 }), { status: 200 })
    },
  }
}
