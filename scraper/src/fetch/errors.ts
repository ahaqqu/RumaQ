// The fetch ladder's typed errors. These live in their own module (not
// strategy.ts) so browser.ts and strategy.ts can share them without a
// runtime import cycle: strategy.ts pulls createBrowserFetcher from
// browser.ts (the Tier-2 dispatch), while browser.ts needs the error
// classes to type its failures — both now import them from here.

import { Data } from 'effect'

export class BrowserTierRequired extends Data.TaggedError('BrowserTierRequired')<{
  url: string
  message: string
}> {}

export class FetchTransport extends Data.TaggedError('FetchTransport')<{
  url: string
  cause: unknown
  message: string
}> {}

export class FetchHttpStatus extends Data.TaggedError('FetchHttpStatus')<{
  url: string
  status: number
  statusText: string
  message: string
}> {}

export class NonImageContent extends Data.TaggedError('NonImageContent')<{
  url: string
  contentType: string
  message: string
}> {}

/**
 * Structural churn on a scraped surface: the anchors/config the parser
 * contract keys on are gone (zero brochure links on a hub, zero product
 * cards on a campaign page). Goes red — never a silent zero — while riding
 * the existing per-store isolation (the run's other stores keep publishing;
 * the failed store reddens the run). Deliberately NOT BrowserTierRequired,
 * so it never masquerades as a needs-proxy skip. Introduced with Indomaret's
 * sentinels (issue #322 design-arch §1.2); the first catalog+browser store
 * (Alfamart, §1.3) reuses the same tag.
 */
export class ScrapeStructureError extends Data.TaggedError('ScrapeStructureError')<{
  url: string
  message: string
}> {}

/**
 * The PDF → page-image render step failed (issue #322 design-arch §1.2):
 * poppler's pdftoppm missing from PATH (a typed red naming the binary,
 * never a silent zero), a non-zero exit on a corrupt document, or a render
 * that produced no pages.
 */
export class PdfRenderError extends Data.TaggedError('PdfRenderError')<{
  message: string
  cause?: unknown
}> {}

export type FetchError =
  | BrowserTierRequired
  | FetchTransport
  | FetchHttpStatus
  | NonImageContent
  | ScrapeStructureError
  | PdfRenderError
