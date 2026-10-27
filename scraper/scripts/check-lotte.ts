// Lotte reachability gate (docs/plan/haqita-integration.md §2 fail-fast).
// Run from the VPS: decides whether Tier-1 plain fetch can reach
// lottemart.co.id or whether Tier-2 (Playwright, PR3) is required.
//
//   bun scraper/scripts/check-lotte.ts
//
// Probes with BOTH header sets: the global default and haqita's actual
// per-store Lotte override (lotte.py used en-US Accept-Language on every
// plain request). A set that passes means Tier 1 suffices with that
// override in place; both challenged means the browser tier (and possibly
// Tier 3) is needed from this egress IP.
//
// Exit codes: 0 = plain fetch OK (Tier 1 sufficient)
//             3 = Incapsula challenge detected (Tier 2 required)
//             4 = unreachable / network error

// Top-level await requires a module — this file has no other exports.
export {}

const URLS = ['https://www.lottemart.co.id/', 'https://www.lottemart.co.id/promosi/']

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// The global default (base_scraper.py DEFAULT_HEADERS — the scraper's
// DEFAULT_HEADERS in fetch/strategy.ts) and haqita's actual Lotte override
// (lotte.py HEADERS). Every plain-tier Lotte request historically rode the
// second one.
const HEADER_SETS: Record<string, Record<string, string>> = {
  'global-default (id-ID)': {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  'haqita-lotte (en-US)': {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  },
}

// Incapsula fingerprints: the interstitial challenge script/cookie names.
function incapsulaScore(body: string, headers: Headers): string[] {
  const markers: string[] = []
  if (body.includes('_Incapsula_Resource')) markers.push('body: _Incapsula_Resource')
  if (/visid_incap_|incap_ses_|___utmvc/.test(body)) markers.push('body: incap cookies')
  if (headers.get('x-iinfo') || headers.get('x-cdn') === 'Incapsula')
    markers.push('headers: x-iinfo/x-cdn')
  return markers
}

let worst = 0
for (const [setName, HEADERS] of Object.entries(HEADER_SETS)) {
  process.stdout.write(`[probe] header set: ${setName}\n`)
  for (const url of URLS) {
    process.stdout.write(`[probe] ${url}\n`)
    try {
      const response = await fetch(url, { headers: HEADERS, redirect: 'follow' })
      const body = (await response.text()).slice(0, 200_000)
      const markers = incapsulaScore(body, response.headers)
      const looksHtml = /<html[\s>]/i.test(body)
      if (response.status === 200 && looksHtml && markers.length === 0) {
        process.stdout.write(
          `  OK    HTTP 200, ${body.length} bytes of HTML — no Incapsula markers\n`
        )
      } else if (markers.length > 0 || response.status === 403) {
        worst = Math.max(worst, 3)
        process.stdout.write(
          `  FAIL  HTTP ${response.status} — Incapsula challenge (${markers.join('; ') || 'status 403'}) → Tier-2 (browser) required\n`
        )
      } else {
        worst = Math.max(worst, 3)
        process.stdout.write(
          `  FAIL  HTTP ${response.status}, html=${looksHtml} — not a normal page → escalate to Tier-2\n`
        )
      }
    } catch (error) {
      worst = Math.max(worst, 4)
      process.stdout.write(`  ERR   ${String(error)}\n`)
    }
  }
}

process.stdout.write(
  worst === 0
    ? '\nPASS: plain fetch reaches Lotte from this egress IP (Tier 1 sufficient).\n'
    : worst === 3
      ? '\nCHALLENGE: Lotte blocks plain fetch from this egress IP — proceed with Tier-2 (Playwright) in PR3.\n'
      : '\nUNREACHABLE: network-level failure — check DNS/egress before deciding tiers.\n'
)
process.exit(worst)
