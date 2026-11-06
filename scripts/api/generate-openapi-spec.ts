import { writeFileSync } from 'node:fs'
import { generateSpecs } from 'hono-openapi'
import { API_APPS } from './app-registry.js'

// Generates the OpenAPI contract consumed by the typed API client
// (`bun run api:codegen` → openapi.json → openapi-typescript). CI regenerates
// this file and fails on diff so backend route drift breaks the build.
//
// The app list lives in scripts/api/app-registry.ts — both this generator and
// scripts/docs/generate-api-docs.ts iterate it, so registering a new domain
// app is one edit in one file. The auth app is the one scripted special case:
// it mounts routes without the /api/auth prefix (the gateway adds it), so its
// paths are remapped to the URLs the browser actually calls.

const DOCS_OPTIONS = {
  documentation: {
    info: { title: 'RumaQ API', version: '0.1.0' },
  },
}

const AUTH_PATH_REMAP: Record<string, string> = {
  '/login': '/api/auth/login',
  '/callback': '/api/auth/callback',
  '/logout': '/api/auth/logout',
  '/email-login': '/api/auth/email-login',
}

const specs = await Promise.all(
  API_APPS.map(async ({ name, app }) => ({ name, spec: await generateSpecs(app, DOCS_OPTIONS) }))
)
const specByName = Object.fromEntries(specs.map(({ name, spec }) => [name, spec]))

// Paths merge in registry order; the auth app's entries are remapped in place.
const merged: Record<string, unknown> = {}
for (const { name } of API_APPS) {
  const appPaths = specByName[name].paths
  Object.assign(
    merged,
    name === 'auth'
      ? Object.fromEntries(
          Object.entries(appPaths).map(([path, methods]) => [
            AUTH_PATH_REMAP[path] ?? path,
            methods,
          ])
        )
      : appPaths
  )
}

const spec = {
  openapi: specByName.api.openapi ?? '3.1.0',
  info: { title: 'RumaQ API', version: '0.1.0' },
  // Internal service routes (bearer-secret ingest) are not part of the
  // browser client contract.
  paths: Object.fromEntries(
    Object.entries(merged).filter(([path]) => !path.startsWith('/api/internal/'))
  ),
  components: Object.assign({}, ...API_APPS.map(({ name }) => specByName[name].components)),
}

writeFileSync('frontend/openapi.json', `${JSON.stringify(spec, null, 2)}\n`)
console.log('✓ Generated frontend/openapi.json')
