// Scrape agent tests (docs/plan/scrape-now.md §2) — URL derivation, config
// resolution, event shaping, and the full command lifecycle (claim → spawn →
// stream → finish) with the spawn and fetch seams faked. Timers are kept
// long/never-firing; the line-count cadence and the final drain do the work.

import { describe, expect, it } from 'vite-plus/test'

import {
  agentConfigFromEnv,
  defaultSpawn,
  deriveScrapeBase,
  lineToEvent,
  pollOnce,
  runCommand,
  type AgentChild,
  type AgentConfig,
  type AgentSpawn,
} from '../src/agent.js'

const baseConfig: AgentConfig = {
  scrapeBase: 'https://api.example.com/api/internal/scrape',
  secret: 's3cret',
  distDir: '/srv/dist',
  stateDir: '/srv/state',
  bunPath: '/usr/bin/bun',
  flockPath: '/usr/bin/flock',
  lockPath: '/srv/state/run.lock',
  lockWaitSec: 1800,
  pollMs: 15_000,
  childTimeoutMs: 60 * 60 * 1000,
  maxBufferBytes: 512 * 1024,
  maxBufferEvents: 5000,
  // Interval never fires inside a test — flushes are line-driven + final.
  flushIntervalMs: 60 * 60 * 1000,
  flushBatchLines: 25,
  postTimeoutMs: 5_000,
}

function textStream(lines: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  return (async function* () {
    for (const line of lines) yield encoder.encode(`${line}\n`)
  })()
}

type RecordedPost = { url: string; body: unknown; auth: string | undefined }

/** Fake fetch recording scrape events + finish posts; everything answers 200. */
function fakeApi() {
  const posts: RecordedPost[] = []
  const eventsBatches: Array<Array<{ seq: number; message: string; level: string }>> = []
  const finishes: Array<Record<string, unknown>> = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const u = String(url)
    const body = init?.body ? JSON.parse(init.body as string) : null
    const auth = (init?.headers as Record<string, string>)?.Authorization
    if (u.endsWith('/events')) {
      posts.push({ url: u, body, auth })
      if (!Array.isArray(body?.events)) throw new Error('events POST without events array')
      eventsBatches.push(body.events)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (u.endsWith('/finish')) {
      posts.push({ url: u, body, auth })
      finishes.push(body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 })
  }
  return { fetch, posts, eventsBatches, finishes }
}

function fakeSpawn(
  stdout: string[],
  stderr: string[] = [],
  exitCode: number | null = 0
): { spawn: AgentSpawn; commands: string[][]; killed: () => boolean } {
  const commands: string[][] = []
  let wasKilled = false
  const spawn: AgentSpawn = (cmd) => {
    commands.push(cmd)
    const child: AgentChild = {
      stdout: textStream(stdout),
      stderr: textStream(stderr),
      exited: new Promise((resolve) => {
        queueMicrotask(() => resolve(exitCode))
      }),
      kill: () => {
        wasKilled = true
      },
    }
    return child
  }
  return { spawn, commands, killed: () => wasKilled }
}

describe('deriveScrapeBase', () => {
  it('swaps the ingest route for the scrape base', () => {
    expect(deriveScrapeBase('https://rumaq.ahaqqu.com/api/internal/ingest/prices')).toBe(
      'https://rumaq.ahaqqu.com/api/internal/scrape'
    )
  })

  it('falls back to the origin for an unexpected path', () => {
    expect(deriveScrapeBase('https://rumaq.ahaqqu.com/other')).toBe(
      'https://rumaq.ahaqqu.com/other/api/internal/scrape'
    )
  })
})

describe('agentConfigFromEnv', () => {
  it('is null when the ingest env is unconfigured (idle box, no crash)', () => {
    expect(agentConfigFromEnv({})).toBeNull()
    expect(
      agentConfigFromEnv({ RUMAQ_INGEST_URL: 'https://x/api/internal/ingest/prices' })
    ).toBeNull()
  })

  it('derives the scrape base and the lock path from the standard env', () => {
    const config = agentConfigFromEnv({
      RUMAQ_INGEST_URL: 'https://rumaq.ahaqqu.com/api/internal/ingest/prices',
      RUMAQ_INGEST_SECRET: 'k',
    })
    expect(config!.scrapeBase).toBe('https://rumaq.ahaqqu.com/api/internal/scrape')
    expect(config!.lockPath).toBe('state/run.lock')
    expect(config!.pollMs).toBe(15_000)
    expect(config!.childTimeoutMs).toBe(60 * 60 * 1000)
    expect(config!.maxBufferBytes).toBe(512 * 1024)
    expect(config!.maxBufferEvents).toBe(5000)
  })

  it('honors RUMAQ_SCRAPER_STATE_DIR and RUMAQ_SCRAPER_DIST_DIR', () => {
    const config = agentConfigFromEnv({
      RUMAQ_INGEST_URL: 'https://x/api/internal/ingest/prices',
      RUMAQ_INGEST_SECRET: 'k',
      RUMAQ_SCRAPER_STATE_DIR: '/var/lib/rumaq-scraper',
      RUMAQ_SCRAPER_DIST_DIR: '/srv/rumaq-scraper/dist',
    })
    expect(config!.stateDir).toBe('/var/lib/rumaq-scraper')
    expect(config!.distDir).toBe('/srv/rumaq-scraper/dist')
    expect(config!.lockPath).toBe('/var/lib/rumaq-scraper/run.lock')
  })
})

describe('lineToEvent', () => {
  it('uses the scraper log ISO prefix as the event timestamp', () => {
    const event = lineToEvent(3, '2026-10-28T01:02:03.123Z [pipeline] hello', 'stdout')
    expect(event).toEqual({
      seq: 3,
      ts: '2026-10-28T01:02:03.123Z',
      level: 'info',
      message: '2026-10-28T01:02:03.123Z [pipeline] hello',
    })
  })

  it('stamps stderr lines and /error|fail/i matches as errors', () => {
    expect(lineToEvent(0, 'boom', 'stderr').level).toBe('error')
    expect(lineToEvent(1, '2026-10-28T01:00:00Z [x] Error: nope', 'stdout').level).toBe('error')
    expect(lineToEvent(2, 'pipeline failed for superindo', 'stdout').level).toBe('error')
    expect(lineToEvent(3, 'all good', 'stdout').level).toBe('info')
  })

  it('falls back to now() for unprefixed lines and truncates to 8000 chars', () => {
    const event = lineToEvent(0, 'plain line', 'stdout', () => new Date('2026-10-28T09:09:09Z'))
    expect(event.ts).toBe('2026-10-28T09:09:09.000Z')
    expect(lineToEvent(0, 'x'.repeat(9000), 'stdout').message).toHaveLength(8000)
  })
})

describe('runCommand lifecycle', () => {
  const command = { id: 'cmd-1', stores: ['superindo', 'astro'], createdAt: '2026-10-28T01:00:00Z' }

  it('spawns flock-wrapped index.js with the scoped stores and finishes success', async () => {
    const api = fakeApi()
    const { spawn, commands } = fakeSpawn([
      '2026-10-28T01:00:01Z [pipeline] starting',
      '2026-10-28T01:00:05Z [pipeline] done',
    ])
    await runCommand(command, baseConfig, {
      fetch: api.fetch,
      spawn,
      now: () => new Date('2026-10-28T01:00:00Z'),
      log: () => {},
    })

    expect(commands).toHaveLength(1)
    expect(commands[0]).toEqual([
      '/usr/bin/flock',
      '-w',
      '1800',
      '/srv/state/run.lock',
      '/usr/bin/bun',
      '/srv/dist/index.js',
      '--publish',
      '--stores=superindo,astro',
      '--state-dir=/srv/state',
    ])

    // Events streamed with monotonic seqs and the bearer secret.
    const allEvents = api.eventsBatches.flat()
    expect(allEvents.map((e) => e.seq)).toEqual([0, 1])
    expect(allEvents[1]!.message).toBe('2026-10-28T01:00:05Z [pipeline] done')
    expect(api.posts.every((p) => p.auth === 'Bearer s3cret')).toBe(true)
    expect(api.posts.every((p) => p.url.startsWith(baseConfig.scrapeBase))).toBe(true)

    // Exactly one finish: success, exit 0, nothing truncated.
    expect(api.finishes).toHaveLength(1)
    expect(api.finishes[0]).toEqual({
      status: 'success',
      exitCode: 0,
      error: null,
      logTruncated: false,
    })
  })

  it('classifies exit codes: 2 stays quota, a signal kill becomes 1', async () => {
    for (const [exit, expected] of [
      [2, { status: 'failed', exitCode: 2 }],
      [null, { status: 'failed', exitCode: 1 }],
      [7, { status: 'failed', exitCode: 1 }],
    ] as const) {
      const api = fakeApi()
      const { spawn } = fakeSpawn([], [], exit)
      await runCommand(command, baseConfig, { fetch: api.fetch, spawn, log: () => {} })
      expect(api.finishes[0]).toMatchObject(expected)
    }
  })

  it('surfaces the last error line as the finish error', async () => {
    const api = fakeApi()
    const { spawn } = fakeSpawn(
      ['2026-10-28T01:00:01Z ok'],
      [
        '2026-10-28T01:00:02Z [pipeline] store superindo failed: dead',
        '2026-10-28T01:00:03Z [pipeline] PipelineFailure: giving up',
      ],
      1
    )
    await runCommand(command, baseConfig, { fetch: api.fetch, spawn, log: () => {} })
    expect(api.finishes[0]).toMatchObject({
      status: 'failed',
      exitCode: 1,
      error: '2026-10-28T01:00:03Z [pipeline] PipelineFailure: giving up',
    })
  })

  it('fails fast without spawning when no claimed slug is valid', async () => {
    const api = fakeApi()
    const { spawn, commands } = fakeSpawn([])
    await runCommand(
      { id: 'cmd-2', stores: ['tokopedia', '../../etc'], createdAt: '2026-10-28T01:00:00Z' },
      baseConfig,
      { fetch: api.fetch, spawn, log: () => {} }
    )
    expect(commands).toHaveLength(0)
    expect(api.finishes[0]).toMatchObject({ status: 'failed', exitCode: 1 })
    expect(String(api.finishes[0]!.error)).toContain('no valid store slugs')
  })

  it('keeps the tail when the ring buffer overflows and flags logTruncated', async () => {
    const api = fakeApi()
    const { spawn } = fakeSpawn(
      Array.from({ length: 30 }, (_, i) => `line ${i}`) // > maxBufferEvents below
    )
    await runCommand(
      command,
      { ...baseConfig, maxBufferEvents: 10 },
      {
        fetch: api.fetch,
        spawn,
        log: () => {},
      }
    )
    // Seqs stay monotonic and gap-free (dropped head events keep their seqs):
    // the admin sees a contiguous tail plus the truncation flag.
    const seqs = api.eventsBatches.flat().map((e) => e.seq)
    expect(seqs).toEqual(seqs.slice().sort((a, b) => a - b))
    expect(api.finishes[0]).toMatchObject({ status: 'success', logTruncated: true })
  })

  it('retries a failed events POST and still drains everything (idempotent receiver)', async () => {
    let eventPostCalls = 0
    const finishes: Array<Record<string, unknown>> = []
    const seenSeqs: number[][] = []
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.endsWith('/events')) {
        eventPostCalls++
        const body = JSON.parse(init!.body as string)
        if (eventPostCalls === 1) return new Response('nope', { status: 503 })
        seenSeqs.push(body.events.map((e: { seq: number }) => e.seq))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (u.endsWith('/finish')) {
        finishes.push(JSON.parse(init!.body as string))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 500 })
    }

    const { spawn } = fakeSpawn(['a', 'b', 'c'])
    await runCommand(command, baseConfig, { fetch, spawn, log: () => {} })
    // First POST attempt failed (503), the retry drained all three lines.
    expect(eventPostCalls).toBeGreaterThanOrEqual(2)
    expect(seenSeqs.flat()).toEqual([0, 1, 2])
    expect(finishes[0]).toMatchObject({ status: 'success' })
  })

  it('kills a wedged child at the hard timeout and finishes failed', async () => {
    const api = fakeApi()
    const commands: string[][] = []
    let killed = false
    const spawn: AgentSpawn = (cmd) => {
      commands.push(cmd)
      return {
        stdout: textStream([]),
        stderr: textStream([]),
        // Never resolves until killed — a wedged scrape.
        exited: new Promise<number | null>((resolve) => {
          const check = setInterval(() => {
            if (killed) {
              clearInterval(check)
              resolve(null)
            }
          }, 1)
        }),
        kill: () => {
          killed = true
        },
      }
    }
    await runCommand(
      command,
      { ...baseConfig, childTimeoutMs: 20 },
      {
        fetch: api.fetch,
        spawn,
        log: () => {},
      }
    )
    expect(killed).toBe(true)
    expect(api.finishes[0]).toMatchObject({ status: 'failed', exitCode: 1 })
    expect(String(api.finishes[0]!.error)).toContain('timeout')
  })
})

describe('pollOnce', () => {
  it('returns false when the queue is empty', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ command: null }), { status: 200 })
    const worked = await pollOnce(baseConfig, {
      fetch,
      spawn: fakeSpawn([]).spawn,
    })
    expect(worked).toBe(false)
  })

  it('claims and drives a command to completion', async () => {
    const finishes: Array<Record<string, unknown>> = []
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.endsWith('/next')) {
        return new Response(
          JSON.stringify({
            command: { id: 'cmd-9', stores: ['astro'], createdAt: '2026-10-28T01:00:00Z' },
          }),
          { status: 200 }
        )
      }
      if (u.endsWith('/finish')) {
        finishes.push(JSON.parse(init!.body as string))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const { spawn, commands } = fakeSpawn(['done'])
    const worked = await pollOnce(baseConfig, {
      fetch,
      spawn,
      log: () => {},
    })
    expect(worked).toBe(true)
    expect(commands[0]).toContain('--stores=astro')
    expect(finishes[0]).toMatchObject({ status: 'success', exitCode: 0 })
  })

  it('propagates HTTP failures (the loop logs + continues)', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response('down', { status: 503 })
    await expect(
      pollOnce(baseConfig, {
        fetch,
        spawn: fakeSpawn([]).spawn,
      })
    ).rejects.toThrow('HTTP 503')
  })
})

describe('defaultSpawn (real process group)', () => {
  // Regression for the hard-kill path: the spawned command is `flock … bun …`,
  // and flock fork+exec's the scraper — a plain proc.kill() would orphan the
  // grandchild, which keeps the stdio pipes open and wedges the agent past
  // the timeout. The kill must reach the whole process GROUP.
  it('kills grandchildren holding stdio, so close fires promptly', async () => {
    const child = defaultSpawn(['/bin/sh', '-c', 'sleep 30 & wait'], { env: {} })
    const closed = child.exited.then(() => true)
    await new Promise((resolve) => setTimeout(resolve, 150)) // let sh fork the sleep
    child.kill()
    const closedSoon = await Promise.race([
      closed,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
    ])
    expect(closedSoon).toBe(true)
  }, 10_000)
})
