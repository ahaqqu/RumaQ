import { writeFileSync } from 'node:fs'
import { generateSpecs } from 'hono-openapi'
import { apiApp } from '../../backend/src/apps/api.js'
import { authApp } from '../../backend/src/apps/auth.js'

// Generates the OpenAPI contract consumed by the typed API client
// (`bun run api:codegen` → openapi.json → openapi-typescript). CI regenerates
// this file and fails on diff so backend route drift breaks the build.

const DOCS_OPTIONS = {
  documentation: {
    info: { title: 'RumaQ API', version: '0.1.0' },
  },
}

const [apiSpec, authSpec] = await Promise.all([
  generateSpecs(apiApp, DOCS_OPTIONS),
  generateSpecs(authApp, DOCS_OPTIONS),
])

// The auth app mounts routes without the /api/auth prefix (the gateway adds
// it); remap so the client schema matches the URLs the browser actually calls.
const AUTH_PATH_REMAP: Record<string, string> = {
  '/login': '/api/auth/login',
  '/callback': '/api/auth/callback',
  '/logout': '/api/auth/logout',
  '/email-login': '/api/auth/email-login',
}

const authPaths = Object.fromEntries(
  Object.entries(authSpec.paths ?? {}).map(([path, methods]) => [
    AUTH_PATH_REMAP[path] ?? path,
    methods,
  ])
)

const spec = {
  openapi: apiSpec.openapi ?? '3.1.0',
  info: { title: 'RumaQ API', version: '0.1.0' },
  paths: { ...apiSpec.paths, ...authPaths },
  components: { ...apiSpec.components, ...authSpec.components },
}

writeFileSync('frontend/openapi.json', `${JSON.stringify(spec, null, 2)}\n`)
console.log('✓ Generated frontend/openapi.json')
