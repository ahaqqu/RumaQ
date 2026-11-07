// Transport helpers shared by the four adapters. The per-vendor knowledge (the
// endpoint, the auth header, the body shape) stays in each adapter; this file
// only removes copy-paste from the failure vocabulary and the media encoding
// (plan §5.4).

import { AdapterError, type AdapterErrorDetail } from './types.js'

const ERROR_BODY_MAX_CHARS = 200

export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** The host of a base URL, or null when it does not parse (never throws). */
export function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return null
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

export function toDataUri(bytes: ArrayBuffer, mimeType: string): string {
  return `data:${mimeType};base64,${arrayBufferToBase64(bytes)}`
}

/**
 * `fetch` with the provider-specific failure vocabulary applied. A transport
 * throw or a caller/deadline abort is typed here; an HTTP failure is typed by
 * `responseError` below (it needs the status).
 */
export async function providerFetch(
  label: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    if (isAbort(err, init.signal)) {
      throw new AdapterError('timeout', `${label} request timed out`)
    }
    throw new AdapterError(
      'provider_error',
      `${label} request failed: ${err instanceof Error ? err.message : 'network error'}`
    )
  }
}

function isAbort(err: unknown, signal: AbortSignal | null | undefined): boolean {
  if (signal?.aborted) return true
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/** `Retry-After` in seconds, when the response carries one. */
export function retryAfterSeconds(res: Response): number | undefined {
  const headers = (res as { headers?: Headers }).headers
  const raw = headers?.get?.('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/**
 * Map a non-OK response onto the adapter vocabulary. The body is included so
 * the route-level message keeps the provider's label and status (plan §5.2);
 * it is TRUNCATED — a provider error body must never be echoed at length, and
 * the key is never part of the message (we do not send it back).
 */
export async function responseError(
  label: string,
  res: Response,
  detail: AdapterErrorDetail = {}
): Promise<AdapterError> {
  let body = ''
  try {
    body = (await res.text()).slice(0, ERROR_BODY_MAX_CHARS)
  } catch {
    // A body that cannot be read is not itself an error worth surfacing.
  }
  const message = `${label} request failed: ${res.status} ${body}`.trim()
  const shared: AdapterErrorDetail = { ...detail, providerStatus: res.status }
  if (res.status === 401 || res.status === 403) {
    return new AdapterError('auth', message, shared)
  }
  if (res.status === 429) {
    return new AdapterError('rate_limited', message, {
      ...shared,
      retryAfterSeconds: retryAfterSeconds(res),
    })
  }
  return new AdapterError('provider_error', message, shared)
}

/** Parse a JSON response body, typing a parse failure as `invalid_response`. */
export async function readJson<T>(label: string, res: Response): Promise<T> {
  try {
    return (await res.json()) as T
  } catch (err) {
    throw new AdapterError(
      'invalid_response',
      `${label} returned unparseable JSON: ${err instanceof Error ? err.message : 'parse failed'}`,
      { providerStatus: res.status }
    )
  }
}

/** A non-empty text answer, or `invalid_response` (empty content is a failure). */
export function requireText(
  label: string,
  text: string | undefined | null,
  usage: AdapterErrorDetail['usage']
): string {
  if (!text) {
    throw new AdapterError('invalid_response', `${label} returned empty response`, { usage })
  }
  return text
}
