#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DB_NAME = process.argv[2] || 'rumaq'
const MIGRATIONS_DIR = resolve('backend', 'migrations')
const LOCAL_DATABASE_ID = '00000000-0000-4000-8000-000000000000'

// cf CLI is invoked through Node: loading cloudflare.config.ts is not
// supported when cf itself runs on Bun.
function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  })
  if (result.status !== 0) {
    console.error(`\nCommand failed: ${command} ${args.join(' ')}`)
    process.exit(result.status || 1)
  }
  return result
}

function runCapture(command, args = []) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
  })
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function cf(args) {
  return runCapture('node', [resolve('node_modules', 'cf', 'bin', 'cf'), ...args])
}

function parseJson(raw) {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

function findDatabase(name) {
  const list = cf(['d1', 'list'])
  if (list.status !== 0) {
    console.error('Unable to list D1 databases. Set CLOUDFLARE_API_TOKEN or run `cf login`.')
    process.exit(1)
  }
  const parsed = parseJson(list.stdout)
  const dbs = Array.isArray(parsed) ? parsed : (parsed?.result ?? [])
  return dbs.find((d) => d.name === name)
}

console.log(`Setting up RumaQ D1 database: ${DB_NAME}\n`)

if (!existsSync(MIGRATIONS_DIR)) {
  console.error(`Migrations directory not found: ${MIGRATIONS_DIR}`)
  process.exit(1)
}

const existing = findDatabase(DB_NAME)

if (!existing?.uuid) {
  console.log(`Creating D1 database "${DB_NAME}"...`)
  run('node', [resolve('node_modules', 'cf', 'bin', 'cf'), 'd1', 'create', '--name', DB_NAME])
  const created = findDatabase(DB_NAME)
  console.log(
    '\nIMPORTANT: export the database_id above as CLOUDFLARE_DATABASE_ID or add it to your .env file.\n'
  )
  if (created?.uuid) console.log(`database_id: ${created.uuid}`)
} else {
  console.log(`Database "${DB_NAME}" already exists (${existing.uuid}).`)
}

console.log('Applying migrations locally...')
run('node', [
  resolve('node_modules', 'cf', 'bin', 'cf'),
  'd1',
  'migrations',
  'apply',
  LOCAL_DATABASE_ID,
  '--local',
  '--dir',
  'backend/migrations',
  '--persist-to',
  resolve('backend', '.cloudflare', 'state'),
])

console.log('\nDone. Run the following to apply to production:')
console.log('  bun run db:migrate --filter backend  (with CLOUDFLARE_DATABASE_ID set)')
