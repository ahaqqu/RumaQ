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

export type FetchError = BrowserTierRequired | FetchTransport | FetchHttpStatus | NonImageContent
