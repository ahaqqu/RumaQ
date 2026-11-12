#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

// Per-run results directory (#356 review B3). The runner passes
// automation/test-results/runs/<run-id>; the default keeps a manual invocation
// working against the legacy shared location.
const resultsRoot = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(ROOT, 'automation/test-results')

const vitestJsonPath = resolve(resultsRoot, 'vitest/api-results.json')
const playwrightReportDir = resolve(resultsRoot, 'playwright')
const outputPath = resolve(resultsRoot, 'test-report.html')

const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)

function readVitestResults() {
  if (!existsSync(vitestJsonPath)) return null
  return JSON.parse(readFileSync(vitestJsonPath, 'utf-8'))
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stepPrefix(title) {
  const t = title.trim()
  if (/^returns/i.test(t)) return 'Then'
  if (/^filters/i.test(t)) return 'When'
  if (/^orders/i.test(t)) return 'Then'
  if (/^allows/i.test(t)) return 'Then'
  if (/^rejects/i.test(t)) return 'Then'
  if (/^requires/i.test(t)) return 'Then'
  if (/^sends/i.test(t)) return 'And'
  return ''
}

function generateHtml(vitest) {
  const apiPassed = vitest?.numPassedTests ?? 0
  const apiFailed = vitest?.numFailedTests ?? 0
  const apiSkipped = vitest?.numPendingTests ?? 0
  const apiTotal = vitest?.numTotalTests ?? 0
  const apiFiles = vitest?.testResults ?? []
  const apiSuccess = apiFailed === 0 && apiTotal > 0

  const playwrightIndex = existsSync(resolve(playwrightReportDir, 'index.html'))

  // Group tests by ancestor (describe block) per file
  let scenarioHtml = ''
  for (const file of apiFiles) {
    const tests = file.assertionResults ?? []
    if (!tests.length) continue

    // Group by ancestorTitles (first element = scenario)
    const groups = {}
    for (const t of tests) {
      const key = (t.ancestorTitles ?? ['']).join(' > ')
      if (!groups[key]) groups[key] = { ancestor: t.ancestorTitles ?? [], tests: [] }
      groups[key].tests.push(t)
    }

    for (const [groupKey, group] of Object.entries(groups)) {
      const scenario = group.ancestor[0] ?? groupKey
      const steps = group.tests
        .map((t) => {
          const status =
            t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped'
          const prefix = stepPrefix(t.title)
          const failureMsg = t.failureMessages?.length ? t.failureMessages[0] : ''
          const errorBlock = failureMsg
            ? `<details class="error-detail"><summary>details</summary><pre>${esc(failureMsg.slice(0, 500))}</pre></details>`
            : ''
          return `<div class="step ${status}">
          <span class="step-icon">${status === 'passed' ? '✓' : status === 'failed' ? '✗' : '○'}</span>
          ${prefix ? `<span class="step-keyword">${prefix}</span>` : ''}
          <span class="step-text">${esc(t.title)}</span>
          ${errorBlock}
        </div>`
        })
        .join('\n')

      const groupPassed = group.tests.every((t) => t.status === 'passed')
      const groupFailed = group.tests.some((t) => t.status === 'failed')
      const groupStatus = groupFailed ? 'failed' : groupPassed ? 'passed' : 'skipped'

      scenarioHtml += `<div class="scenario ${groupStatus}">
        <div class="scenario-header">
          <span class="scenario-status">
            ${groupFailed ? '✗' : groupPassed ? '✓' : '○'}
          </span>
          <span class="scenario-name">${esc(scenario)}</span>
          <span class="scenario-count">${group.tests.length} ${group.tests.length === 1 ? 'step' : 'steps'}</span>
        </div>
        ${steps}
      </div>`
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RumaQ Test Report</title>
<style>
  :root {
    --bg: #0d1117;
    --card: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --blue: #58a6ff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5;
  }
  .container { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: var(--text-muted); font-size: 0.875rem; margin-bottom: 24px; }
  .summary {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px; margin-bottom: 24px;
  }
  .stat {
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; text-align: center;
  }
  .stat .num { font-size: 2rem; font-weight: 700; line-height: 1.2; }
  .stat .label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat.pass .num { color: var(--green); }
  .stat.fail .num { color: var(--red); }
  .stat.skip .num { color: var(--yellow); }
  .stat.total .num { color: var(--blue); }

  .overall {
    text-align: center; padding: 20px; border-radius: 8px; margin-bottom: 24px;
    font-size: 1.25rem; font-weight: 700;
  }
  .overall.pass { background: rgba(63,185,80,0.1); color: var(--green); border: 1px solid rgba(63,185,80,0.3); }
  .overall.fail { background: rgba(248,81,73,0.1); color: var(--red); border: 1px solid rgba(248,81,73,0.3); }
  .overall.skip { background: rgba(210,153,34,0.1); color: var(--yellow); border: 1px solid rgba(210,153,34,0.3); }

  .playwright-link {
    display: inline-block; padding: 8px 16px; border-radius: 6px;
    background: var(--card); border: 1px solid var(--border);
    color: var(--blue); text-decoration: none; font-size: 0.875rem; margin-bottom: 24px;
  }
  .playwright-link:hover { border-color: var(--blue); }

  .scenario {
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    margin-bottom: 16px; overflow: hidden;
  }
  .scenario.passed { border-left: 3px solid var(--green); }
  .scenario.failed { border-left: 3px solid var(--red); }
  .scenario-header {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    background: rgba(255,255,255,0.02);
  }
  .scenario-status { font-size: 1rem; }
  .scenario.passed .scenario-status { color: var(--green); }
  .scenario.failed .scenario-status { color: var(--red); }
  .scenario-name { font-weight: 600; font-size: 0.9375rem; flex: 1; }
  .scenario-count { font-size: 0.75rem; color: var(--text-muted); }

  .step {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 16px 8px 16px; font-size: 0.875rem;
    border-bottom: 1px solid rgba(48,54,61,0.5);
  }
  .step:last-child { border-bottom: none; }
  .step-icon { flex-shrink: 0; width: 16px; }
  .step.passed .step-icon { color: var(--green); }
  .step.failed .step-icon { color: var(--red); }
  .step.skipped .step-icon { color: var(--yellow); }
  .step-keyword {
    flex-shrink: 0; font-weight: 700; color: var(--blue); width: 44px;
    font-size: 0.8125rem;
  }
  .step-text { flex: 1; }
  .error-detail { margin-left: auto; flex-shrink: 0; }
  .error-detail summary {
    cursor: pointer; color: var(--red); font-size: 0.75rem;
    padding: 2px 8px; border-radius: 4px;
    background: rgba(248,81,73,0.1);
  }
  pre {
    background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px;
    font-size: 0.75rem; overflow-x: auto; max-height: 200px;
    margin-top: 4px; white-space: pre-wrap; word-break: break-all;
  }

  @media (max-width: 640px) {
    body { padding: 12px; }
    .summary { grid-template-columns: repeat(2, 1fr); }
    .step { flex-wrap: wrap; }
    .step-keyword { width: auto; }
  }
</style>
</head>
<body>
<div class="container">
  <h1>🧪 RumaQ Test Report</h1>
  <p class="subtitle">${esc(timestamp)} &middot; run via Docker test suite</p>

  <div class="overall ${apiSuccess ? 'pass' : apiTotal === 0 ? 'skip' : 'fail'}">
    ${apiSuccess ? 'All tests passed ✓' : apiTotal === 0 ? 'No API tests found' : 'Some tests failed ✗'}
  </div>

  <div class="summary">
    <div class="stat total"><div class="num">${apiTotal}</div><div class="label">Total</div></div>
    <div class="stat pass"><div class="num">${apiPassed}</div><div class="label">Passed</div></div>
    <div class="stat fail"><div class="num">${apiFailed}</div><div class="label">Failed</div></div>
    <div class="stat skip"><div class="num">${apiSkipped}</div><div class="label">Skipped</div></div>
  </div>

  ${playwrightIndex ? `<a class="playwright-link" href="./playwright/index.html" target="_blank">▶ View E2E (Playwright) report</a>` : ''}

  <h2 style="font-size:1rem;margin-bottom:12px;">Scenarios</h2>

  ${scenarioHtml || '<p style="color:var(--text-muted)">No test results</p>'}
</div>
</body>
</html>`
}

const vitest = readVitestResults()
if (vitest) {
  const html = generateHtml(vitest)
  writeFileSync(outputPath, html, 'utf-8')
  console.log(`✓ Test report written to ${relative(ROOT, outputPath)}`)
} else {
  console.log('No vitest results found at', vitestJsonPath)
  process.exit(1)
}
