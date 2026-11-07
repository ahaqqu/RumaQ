/**
 * Determine the public-facing origin of a request, honouring proxy headers.
 *
 * Cloudflare Workers receive the real scheme/host via `request.url`. When running
 * behind a reverse proxy locally, the Worker sees the proxy's internal URL, so
 * we reconstruct the original origin from standard X-Forwarded-* headers.
 *
 * Used for auth redirect URI construction and by the CSRF origin guard
 * (ahaqqu/RumaQ#528), so it must agree with the browser's `Origin` header.
 *
 * Security note: the guard only decides browser-driven requests, and a browser
 * cannot set X-Forwarded-* cross-origin without a CORS preflight (which the
 * allow-list in `cors.ts` refuses), so a client-supplied value cannot be used
 * to forge the "own origin" of a forged write. In production Cloudflare does
 * not add these headers, so the `request.url` fallback is what runs. The local
 * Docker test stack forwards them via its reverse proxy.
 */
/**
 * The two things this helper reads: a Hono `Context['req']` (or a raw `Request`
 * adapted through `requestOriginSource`) satisfies it structurally. Flattened
 * from a whole `Context` so non-Hono callers (the CSRF guard takes a raw
 * `Request`) do not have to fabricate middleware context to ask the question
 * (#528 review B1).
 */
export interface RequestOriginSource {
  url: string
  header: (name: string) => string | undefined
}

/** Adapt a raw `Request` to `RequestOriginSource`. */
export function requestOriginSource(request: Request): RequestOriginSource {
  return { url: request.url, header: (name) => request.headers.get(name) ?? undefined }
}

export function getRequestOrigin(source: RequestOriginSource): string {
  const url = new URL(source.url)

  const forwardedProto = source.header('X-Forwarded-Proto')
  const forwardedHost = source.header('X-Forwarded-Host')
  const forwardedPort = source.header('X-Forwarded-Port')

  if (forwardedHost) {
    const proto = forwardedProto || url.protocol.replace(':', '')
    // A port already carried by the forwarded host wins: appending
    // X-Forwarded-Port on top would produce `host:3000:3000` (the Docker
    // harness sends both; #528's guard parses this value, so it must be a
    // valid origin).
    const port = forwardedHost.includes(':') ? '' : forwardedPort || url.port
    const hostPort = port ? `${forwardedHost}:${port}` : forwardedHost
    return `${proto}://${hostPort}`
  }

  return url.origin
}
