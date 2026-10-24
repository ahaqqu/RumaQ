import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, extname, join } from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../../..')
const BACKEND_DIR = resolve(ROOT, 'backend')
// Vite build output (Workers Build Output Specification): the plugin writes
// the bundled worker to workers/default/bundle under the versioned output root.
const DIST_DIR = resolve(BACKEND_DIR, '.cloudflare/output/v0/workers/default/bundle')

// --- Dynamically build modules array from dist output ---
function collectJsFiles(dir) {
  const files = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(fullPath))
    } else if (entry.isFile() && extname(entry.name) === '.js') {
      files.push({
        type: 'ESModule',
        path: fullPath,
        contents: readFileSync(fullPath, 'utf-8'),
      })
    }
  }
  return files
}

const MODULES = collectJsFiles(DIST_DIR)
// Ensure index.js is first — it's the entry point
const entryIdx = MODULES.findIndex((m) => m.path.endsWith('/index.js'))
if (entryIdx > 0) {
  const entry = MODULES.splice(entryIdx, 1)[0]
  MODULES.unshift(entry)
}

// --- Read SQL files ---
// All D1 migrations are applied in filename order, so new migrations
// (e.g. haqita's 0007) exist in the Docker stack without edits here.
const migrationSql = readdirSync(resolve(BACKEND_DIR, 'migrations'))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(resolve(BACKEND_DIR, 'migrations', file), 'utf-8'))
const seedSql = readFileSync(resolve(ROOT, 'automation/tests/fixtures/seed.sql'), 'utf-8')
const resetSql = readFileSync(resolve(ROOT, 'automation/tests/fixtures/reset.sql'), 'utf-8')

// --- Load the bundled worker module ---
const { Miniflare } = await import('miniflare')

const mf = new Miniflare({
  modules: MODULES,
  modulesRoot: DIST_DIR,
  d1Databases: { DB: 'rumaq-test' },
  r2Buckets: { RECEIPTS: 'rumaq-receipts-test' },
  compatibilityDate: '2026-07-10',
  compatibilityFlags: ['nodejs_compat'],
  bindings: {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    WORKER_JWT_SECRET: 'test-jwt-secret',
    WORKER_ENCRYPTION_KEY: 'a'.repeat(32),
    // Bearer secret for the internal price ingest endpoint (haqita PR1).
    HAQITA_INGEST_SECRET: 'test-ingest-secret',
    TEST_MODE: 'true',
    EMAIL_AUTH_ENABLED: 'true',
    // Rate-limit overrides are optional; newer Miniflare rejects undefined
    // binding values, so only pass them when actually set.
    ...(process.env.RATE_LIMIT_WINDOW_MS && {
      RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
    }),
    ...(process.env.RATE_LIMIT_MAX_REQUESTS && {
      RATE_LIMIT_MAX_REQUESTS: process.env.RATE_LIMIT_MAX_REQUESTS,
    }),
  },
})

// --- Apply migrations & seed ---
const db = await mf.getD1Database('DB')

function flattenSql(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\n\s*/g, ' ')
    .replace(/\s*;\s*/g, ';\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

for (const sql of migrationSql) {
  await db.exec(flattenSql(sql))
}
// Some migrations seed their own test users (e.g. 0002 with INSERT OR IGNORE).
// Reset before the fixture seed so startup always lands on a clean, fully
// seeded state, exactly like the /api/__test/reset + seed flow tests use.
await db.exec(flattenSql(resetSql))
await db.exec(flattenSql(seedSql))

console.log('✓ D1 migrations applied and database seeded')

// --- Start HTTP server wrapping Miniflare's fetch ---
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:8787')

    if (process.env.TEST_MODE === 'true') {
      if (url.pathname === '/api/__test/reset' && req.method === 'POST') {
        await db.exec(flattenSql(resetSql))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/__test/seed' && req.method === 'POST') {
        await db.exec(flattenSql(seedSql))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/__test/direct-sql' && req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const { sql } = body
        if (sql) {
          await db.exec(sql)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
    }

    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value != null) headers.set(key, value)
    }

    let body = null
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      body = Buffer.concat(chunks)
    }

    // If the proxy already passed X-Forwarded-* headers, keep them. Otherwise
    // fill in sensible defaults for this local Docker stack so handlers like
    // auth can reconstruct the public origin for redirect URIs.
    if (!headers.has('X-Forwarded-Proto')) {
      headers.set('X-Forwarded-Proto', 'http')
    }
    if (!headers.has('X-Forwarded-Host')) {
      headers.set('X-Forwarded-Host', req.headers.host || 'localhost:3000')
    }
    if (!headers.has('X-Forwarded-Port')) {
      headers.set('X-Forwarded-Port', '3000')
    }

    // redirect: 'manual' — dispatchFetch otherwise follows 3xx responses and
    // returns the redirect target's body (e.g. Google's login page instead of
    // the expected 302), breaking redirect-asserting scenarios.
    const workerResponse = await mf.dispatchFetch(url.toString(), {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    })
    const responseBody = await workerResponse.text()

    // Strip headers that conflict with Node.js http.ServerResponse
    const sanitizedHeaders = Object.fromEntries(
      [...workerResponse.headers].filter(
        ([key]) =>
          !['content-length', 'transfer-encoding', 'connection', 'date', 'keep-alive'].includes(key)
      )
    )
    res.writeHead(workerResponse.status, sanitizedHeaders)
    res.end(responseBody)
  } catch (err) {
    console.error('Worker server error:', err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
})

server.listen(8787, '0.0.0.0', () => {
  console.log('✓ Worker server listening on http://0.0.0.0:8787')
})

process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  server.close()
  await mf.dispose()
  process.exit(0)
})
