// Scrape Now agent (docs/plan/scrape-now.md §2) — a long-running service on
// the VPS that polls the Worker's command queue and drives on-demand scrapes:
//
//   every 15s  GET  {base}/api/internal/scrape/next          → claim (or null)
//   on claim   flock run.lock → spawn index.js --publish --stores=… →
//              stream child stdout+stderr lines → POST …/commands/:id/events
//   on exit    POST …/commands/:id/finish (status/exitCode/error)
//
// The base URL and bearer are derived from the SAME RUMAQ_INGEST_URL /
// RUMAQ_INGEST_SECRET env vars the pipeline already uses (same derivation
// pattern as deriveRunsUrl) — no new env vars. The nightly timer path is
// untouched; flock on <stateDir>/run.lock guarantees a manual run and the
// nightly never overlap (the nightly side wraps its own ExecStart in
// `flock -n`, so a collision skips tonight's run instead of queuing).
//
// Failure philosophy: the agent NEVER exits on error (systemd Restart=always
// is only a backstop) — a dead Worker, a failed POST, a crashed child are all
// logged and the loop continues. A command whose finish POST never lands is
// swept to 'failed' by the Worker's stale sweep after 2h.
//
// Event backpressure: lines are batch-posted (≈2s or 25 lines) with the
// agent-assigned monotonic seq as the idempotency key (the Worker upserts
// ON CONFLICT DO NOTHING). A ring buffer bounds unposted events at
// 512KB / 5000 events — overflow drops the HEAD and raises logTruncated, so
// the admin always sees the TAIL of the log, never unbounded memory.

import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'

import { SCRAPE_STORE_SLUGS } from '@rumaq/contract'

import { createLog, type LogFn } from './util/log.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** …/api/internal/ingest/prices → <origin>/api/internal/scrape */
export function deriveScrapeBase(ingestUrl: string): string {
  const marker = '/api/internal/ingest/'
  const idx = ingestUrl.indexOf(marker)
  const origin = idx >= 0 ? ingestUrl.slice(0, idx) : ingestUrl.replace(/\/+$/, '')
  return `${origin}/api/internal/scrape`
}

export type AgentConfig = {
  scrapeBase: string
  secret: string
  /** Where index.js lives — the agent bundle ships beside it in dist/. */
  distDir: string
  stateDir: string
  bunPath: string
  flockPath: string
  /** <stateDir>/run.lock — the nightly unit flock -n's the same file. */
  lockPath: string
  /** flock -w: give the nightly up to 30min before the manual run gives up. */
  lockWaitSec: number
  pollMs: number
  /** Hard kill for a wedged child. */
  childTimeoutMs: number
  /** Ring-buffer caps for unposted events (head is dropped, tail kept). */
  maxBufferBytes: number
  maxBufferEvents: number
  /** Batch-post cadence: flush when this much time passed or this many lines. */
  flushIntervalMs: number
  flushBatchLines: number
  /** Per-POST timeout. */
  postTimeoutMs: number
}

export function agentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig | null {
  const ingestUrl = env.RUMAQ_INGEST_URL
  const secret = env.RUMAQ_INGEST_SECRET
  if (!ingestUrl || !secret) return null
  const stateDir = env.RUMAQ_SCRAPER_STATE_DIR ?? 'state'
  return {
    scrapeBase: deriveScrapeBase(ingestUrl),
    secret,
    // The agent bundle and index.js ship side by side in dist/; the script
    // path (argv[1] = …/dist/agent.js) locates them. Override exists for
    // tests and exotic installs.
    distDir: env.RUMAQ_SCRAPER_DIST_DIR ?? path.dirname(process.argv[1] ?? '.'),
    stateDir,
    bunPath: '/usr/bin/bun',
    flockPath: '/usr/bin/flock',
    lockPath: `${stateDir}/run.lock`,
    lockWaitSec: 30 * 60,
    pollMs: 15_000,
    childTimeoutMs: 60 * 60 * 1000,
    maxBufferBytes: 512 * 1024,
    maxBufferEvents: 5000,
    flushIntervalMs: 2_000,
    flushBatchLines: 25,
    postTimeoutMs: 30_000,
  }
}

// --- child process seam (tests inject a fake; prod wraps Bun.spawn) ----------

export interface AgentChild {
  stdout: AsyncIterable<Uint8Array>
  stderr: AsyncIterable<Uint8Array>
  /** Resolves with the exit code, or null when killed by a signal. */
  exited: Promise<number | null>
  kill(): void
}

export type AgentSpawn = (
  cmd: string[],
  opts: { env: Record<string, string | undefined> }
) => AgentChild

/**
 * Spawns the child through node:child_process (fully supported under the Bun
 * runtime, which is what ExecStart uses) as its own process GROUP. `close` —
 * not `exit` — feeds the exited promise so stdio is fully flushed before we
 * read the code.
 */
export function defaultSpawn(
  cmd: string[],
  opts: { env: Record<string, string | undefined> }
): AgentChild {
  const proc = nodeSpawn(cmd[0]!, cmd.slice(1), {
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The command is [flock, …, bun, index.js, …] — flock fork+exec's the
    // scraper, so the process we spawn is only the WRAPPER. A detached spawn
    // makes it a group leader and the kill below signals the whole group;
    // without it, killing flock would orphan the bun scraper (still holding
    // the lock fd and the pipes) and wedge the agent past the hard timeout.
    detached: true,
  })
  return {
    stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
    stderr: proc.stderr as unknown as AsyncIterable<Uint8Array>,
    exited: new Promise((resolve) => proc.on('close', (code) => resolve(code))),
    kill: () => {
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGTERM')
        return
      } catch {
        // Group already reaped (exit raced the timeout) — fall through.
      }
      proc.kill()
    },
  }
}

// --- claimed command + events -------------------------------------------------

export type ClaimedCommand = {
  id: string
  stores: string[]
  createdAt: string
}

export type AgentEvent = {
  seq: number
  ts: string
  level: 'info' | 'error'
  message: string
}

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/

/** One captured output line = one event (docs/plan/scrape-now.md §2). */
export function lineToEvent(
  seq: number,
  line: string,
  source: 'stdout' | 'stderr',
  now: () => Date = () => new Date()
): AgentEvent {
  const trimmed = line.replace(/\r$/, '')
  const parsed = ISO_PREFIX.test(trimmed)
    ? trimmed.slice(0, ISO_PREFIX.exec(trimmed)![0].length)
    : null
  const level: AgentEvent['level'] =
    source === 'stderr' || /error|fail/i.test(trimmed) ? 'error' : 'info'
  return {
    seq,
    ts: parsed ?? now().toISOString(),
    level,
    // Contract cap; a longer line is truncated, never rejected.
    message: trimmed.slice(0, 8000),
  }
}

/** Pipeline exit codes only (0 ok / 1 failure / 2 quota) — anything else is 1. */
function clampExitCode(code: number | null): 0 | 1 | 2 {
  if (code === 0) return 0
  if (code === 2) return 2
  return 1
}

type EventBuffer = {
  pending: AgentEvent[]
  bytes: number
  truncated: boolean
}

function bufferPush(buffer: EventBuffer, event: AgentEvent, config: AgentConfig): void {
  buffer.pending.push(event)
  buffer.bytes += event.message.length
  // Keep the TAIL: drop from the head while over either cap. Dropped events
  // were never posted — the admin view is a tail, hence logTruncated.
  while (buffer.pending.length > config.maxBufferEvents || buffer.bytes > config.maxBufferBytes) {
    const dropped = buffer.pending.shift()
    if (!dropped) break
    buffer.bytes -= dropped.message.length
    buffer.truncated = true
  }
}

// --- HTTP helpers --------------------------------------------------------------

function authHeaders(secret: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }
}

/** POST JSON with a couple of retries; resolves false when all attempts fail. */
async function postJson(
  fetchFn: FetchLike,
  url: string,
  secret: string,
  body: unknown,
  config: AgentConfig,
  log: LogFn
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: authHeaders(secret),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.postTimeoutMs),
      })
      if (res.ok) return true
      // A 4xx (other than 429) can never succeed on retry — give up now.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        log(`[agent] POST ${url} → HTTP ${res.status} (non-retryable)`)
        return false
      }
      log(`[agent] POST ${url} → HTTP ${res.status} (attempt ${attempt + 1})`)
    } catch (cause) {
      log(`[agent] POST ${url} failed (attempt ${attempt + 1}): ${String(cause)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
  }
  return false
}

// --- the command lifecycle -----------------------------------------------------

export type RunCommandDeps = {
  fetch: FetchLike
  spawn: AgentSpawn
  /** Injectable sleep so tests never wait out real intervals. */
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
  log?: LogFn
}

/**
 * Runs one claimed command to completion: flock → spawn → stream → finish.
 * Resolves once the command is terminal in the Worker (or every retry to
 * make it so failed — the Worker's stale sweep is the last resort).
 */
export async function runCommand(
  command: ClaimedCommand,
  config: AgentConfig,
  deps: RunCommandDeps
): Promise<void> {
  const log = deps.log ?? createLog('agent')
  const now = deps.now ?? (() => new Date())
  const eventsUrl = `${config.scrapeBase}/commands/${command.id}/events`
  const finishUrl = `${config.scrapeBase}/commands/${command.id}/finish`

  // Defense-in-depth: the Worker validated these slugs at create time, but
  // the args below end up in a child command line — re-validate here.
  const slugs = [...new Set(command.stores)].filter((slug) =>
    (SCRAPE_STORE_SLUGS as readonly string[]).includes(slug)
  )
  if (slugs.length === 0) {
    log(`[agent] command ${command.id}: no valid stores in ${JSON.stringify(command.stores)}`)
    await postJson(
      deps.fetch,
      finishUrl,
      config.secret,
      {
        status: 'failed',
        exitCode: 1,
        error: 'no valid store slugs in command',
        logTruncated: false,
      },
      config,
      log
    )
    return
  }

  // flock wraps the CHILD, not the agent: the lock is held exactly as long
  // as the scrape runs and released when it exits. The nightly unit holds
  // the same file with flock -n — whoever is first wins, the other skips.
  const cmd = [
    config.flockPath,
    '-w',
    String(config.lockWaitSec),
    config.lockPath,
    config.bunPath,
    `${config.distDir}/index.js`,
    '--publish',
    `--stores=${slugs.join(',')}`,
    `--state-dir=${config.stateDir}`,
  ]
  log(`[agent] command ${command.id}: spawning ${slugs.join(',')}`)
  const child = deps.spawn(cmd, { env: { ...process.env } })

  const buffer: EventBuffer = { pending: [], bytes: 0, truncated: false }
  let nextSeq = 0
  let timedOut = false
  let exitCode: number | null = null
  let lastErrorLine: string | null = null
  let linesSinceFlush = 0

  // Serialized flush chain: batches post strictly in seq order, one at a
  // time, and only fully-posted batches leave the buffer.
  let flushChain: Promise<void> = Promise.resolve()
  const flush = async (): Promise<void> => {
    while (buffer.pending.length > 0) {
      const batch = buffer.pending.slice(0, 100)
      const ok = await postJson(
        deps.fetch,
        eventsUrl,
        config.secret,
        { events: batch },
        config,
        log
      )
      if (!ok) return // keep everything; the next flush retries (idempotent)
      for (const event of batch) buffer.bytes -= event.message.length
      buffer.pending = buffer.pending.slice(batch.length)
    }
  }
  const scheduleFlush = () => {
    flushChain = flushChain
      .then(() => flush())
      .catch((cause) => log(`[agent] flush: ${String(cause)}`))
  }

  const capture = (line: string, source: 'stdout' | 'stderr') => {
    const event = lineToEvent(nextSeq++, line, source, now)
    if (event.level === 'error') lastErrorLine = event.message
    bufferPush(buffer, event, config)
    linesSinceFlush++
    // Lines-based cadence: flush as soon as a batch of lines is waiting.
    if (linesSinceFlush >= config.flushBatchLines) {
      linesSinceFlush = 0
      scheduleFlush()
    }
  }

  const readerDone = Promise.all([
    pumpLines(child.stdout, (line) => capture(line, 'stdout')),
    pumpLines(child.stderr, (line) => capture(line, 'stderr')),
  ]).then(() => undefined)

  // Kill a wedged child after the hard timeout (docs/plan: 60min). The kill
  // closes the pipes, so the readers drain what was buffered and stop.
  const killTimer = setTimeout(() => {
    timedOut = true
    log(`[agent] command ${command.id}: exceeded ${config.childTimeoutMs}ms — killing child`)
    child.kill()
  }, config.childTimeoutMs)

  // Time-based flush cadence while the child runs.
  const flushTimer = setInterval(scheduleFlush, config.flushIntervalMs)

  try {
    // Bounded by the kill timer above: a wedged child gets killed and its
    // `exited` resolves (null). Never wait on the pipes here — a child may
    // close its stdio early and keep running.
    exitCode = await child.exited
  } finally {
    clearTimeout(killTimer)
    clearInterval(flushTimer)
  }
  // The pipes are closed by now (exit or kill) — drain anything buffered.
  // Bounded: a grandchild that inherited the pipe must not wedge the loop
  // forever (whatever arrived by the deadline still gets flushed).
  await Promise.race([readerDone, new Promise((resolve) => setTimeout(resolve, 5000))])

  // Drain whatever the final lines left below the batch threshold — the
  // readers may have captured events after the last scheduled flush.
  flushChain = flushChain.then(flush, () => {})
  await flushChain

  const status: 'success' | 'failed' = !timedOut && exitCode === 0 ? 'success' : 'failed'
  const error = timedOut
    ? `timeout: scrape exceeded ${Math.round(config.childTimeoutMs / 60000)} minutes and was killed`
    : (lastErrorLine ?? (exitCode === 0 ? null : `scrape exited with code ${exitCode ?? 'signal'}`))
  // The kill is authoritative: a timed-out run never reports the success-like
  // exit 0 (a child that exited 0 right at the deadline still failed as a
  // command) — "failed / exit code 0" would read as a contradiction.
  const clampedExit = clampExitCode(exitCode)
  const reportedExit = timedOut && clampedExit === 0 ? 1 : clampedExit

  log(`[agent] command ${command.id}: finished ${status} (exit ${exitCode})`)
  await postJson(
    deps.fetch,
    finishUrl,
    config.secret,
    { status, exitCode: reportedExit, error, logTruncated: buffer.truncated },
    config,
    log
  )
}

/** Splits a byte stream into lines (without the trailing newline). */
async function pumpLines(
  stream: AsyncIterable<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      // Every line is an event — even an empty one the admin would have seen.
      onLine(line)
    }
  }
  buf += decoder.decode()
  if (buf.length > 0) onLine(buf)
}

// --- the poll loop --------------------------------------------------------------

export type PollDeps = RunCommandDeps

/** One poll → at most one claimed command, driven to completion. */
export async function pollOnce(config: AgentConfig, deps: PollDeps): Promise<boolean> {
  const res = await deps.fetch(`${config.scrapeBase}/next`, {
    headers: { Authorization: `Bearer ${config.secret}` },
    signal: AbortSignal.timeout(config.postTimeoutMs),
  })
  if (!res.ok) throw new Error(`scrape/next → HTTP ${res.status}`)
  const body = (await res.json()) as { command: ClaimedCommand | null }
  if (!body.command) return false
  await runCommand(body.command, config, deps)
  return true
}

/**
 * The service loop: never exits. Errors are logged and the loop continues
 * after the poll interval (systemd Restart=always is only a backstop).
 */
export async function runAgentLoop(config: AgentConfig, deps: PollDeps): Promise<never> {
  const log = deps.log ?? createLog('agent')
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  // The promise never resolves; the type lie keeps the signature honest
  // about "this only returns if the process is killed".
  for (;;) {
    try {
      const worked = await pollOnce(config, deps)
      if (worked) continue // another command may be waiting — poll immediately
    } catch (cause) {
      log(`[agent] poll failed (continuing): ${String(cause)}`)
    }
    await sleep(config.pollMs)
  }
}

// --- entrypoint -------------------------------------------------------------------

if (import.meta.main) {
  const config = agentConfigFromEnv()
  if (!config) {
    process.stderr.write(
      '[agent] RUMAQ_INGEST_URL and RUMAQ_INGEST_SECRET must be set (they come\n' +
        '[agent] from /etc/rumaq-scraper/env via the systemd unit).\n'
    )
    process.exit(1)
  }
  const log = createLog('agent')
  log(`polling ${config.scrapeBase}/next every ${config.pollMs}ms`)
  void runAgentLoop(config, { fetch: (...args) => fetch(...args), spawn: defaultSpawn })
}
