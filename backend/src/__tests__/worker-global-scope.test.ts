import { describe, it, expect } from 'vite-plus/test'
// @ts-expect-error — no node types in this tsconfig
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname, relative } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

// WORKERD GLOBAL-SCOPE GUARD (ahaqqu/RumaQ#523 P2 → P3 review B2).
//
// The Worker bundle is evaluated once, at startup, inside workerd's global
// scope. That scope forbids generating random values, starting timers and doing
// IO: `new AbortController()`, `crypto.*`, `Math.random()`, `fetch()`,
// `setTimeout` and friends throw there ("generating random values are not
// allowed within global scope"), and the WHOLE Worker fails to start — every
// route included, not just the one that touched them.
//
// P2 shipped `lib/ai/legacy.ts` with a module-scope `new AbortController()`, the
// Docker stack could not come up, and nothing in the PR gate objected: Node
// permits at module scope exactly what workerd rejects, so all 1,300 unit tests
// stayed green. The only harness that noticed was the automation stack, which
// is nightly. This test is the PR-gate version of that check: a static, AST-based
// scan of every module-scope expression that runs during bundle evaluation.
//
// Scanned: the initializer of every top-level `const`/`let`/`var`, every
// top-level expression statement, and IIFE bodies (they also run during
// evaluation). NOT scanned: ordinary function bodies (they run per call, where
// these APIs are fine), callbacks handed to a call at module scope (that needs a
// call graph), and indirect helpers called at module scope. The shapes that
// caused the outage were direct. Allowed module-scope work stays allowed:
// `new Map`, `new Set`, `new TextEncoder`, `new Hono` and `new URL` are not on
// the list.

const BACKEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['__tests__', 'node_modules'])

type Violation = { file: string; line: number; construct: string; snippet: string }

/** The leftmost identifier of a property chain (`a.b.c` → `a`). */
function rootIdentifier(node: ts.Expression): ts.Identifier | null {
  let current: ts.Expression = node
  for (;;) {
    if (ts.isIdentifier(current)) return current
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression
      continue
    }
    return null
  }
}

/** The banned construct this node is, or null. */
function bannedConstruct(node: ts.Node): string | null {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === 'AbortController') return 'new AbortController()'
    if (node.expression.text === 'Request') return 'new Request()'
  }
  if (!ts.isCallExpression(node)) return null
  const callee = node.expression
  if (ts.isIdentifier(callee)) {
    return ['fetch', 'setTimeout', 'setInterval', 'queueMicrotask'].includes(callee.text)
      ? `${callee.text}()`
      : null
  }
  if (!ts.isPropertyAccessExpression(callee)) return null
  const owner = rootIdentifier(callee)
  if (!owner) return null
  if (owner.text === 'AbortSignal' && ['timeout', 'any'].includes(callee.name.text)) {
    return `AbortSignal.${callee.name.text}()`
  }
  if (owner.text === 'Math' && callee.name.text === 'random') return 'Math.random()'
  if (owner.text === 'performance' && callee.name.text === 'now') return 'performance.now()'
  if (owner.text === 'crypto') return 'crypto.*'
  return null
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  )
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function walkEvaluated(
  node: ts.Node,
  source: ts.SourceFile,
  report: (node: ts.Node, what: string) => void
): void {
  const banned = bannedConstruct(node)
  if (banned) {
    report(node, banned)
    return
  }
  // A function VALUE does not run during evaluation — its body is per-call.
  // (An IIFE is entered by `scanEvaluated`, never through this branch.)
  if (isFunctionLike(node)) return
  ts.forEachChild(node, (child) => walkEvaluated(child, source, report))
}

/** Scan an expression that runs during module evaluation, including IIFEs. */
function scanEvaluated(
  node: ts.Node,
  source: ts.SourceFile,
  report: (node: ts.Node, what: string) => void
): void {
  const banned = bannedConstruct(node)
  if (banned) {
    report(node, banned)
    return
  }
  if (ts.isCallExpression(node)) {
    const callee = unwrapParens(node.expression)
    if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
      for (const arg of node.arguments) walkEvaluated(arg, source, report)
      if (ts.isBlock(callee.body)) {
        for (const statement of callee.body.statements) scanEvaluated(statement, source, report)
      } else {
        scanEvaluated(callee.body, source, report)
      }
      return
    }
  }
  if (isFunctionLike(node)) return
  ts.forEachChild(node, (child) => scanEvaluated(child, source, report))
}

function scanFile(file: string): Violation[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const violations: Violation[] = []
  const report = (node: ts.Node, construct: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.push({
      file: relative(BACKEND_SRC, file),
      line: line + 1,
      construct,
      snippet: node.getText(source).split('\n')[0]!.slice(0, 120),
    })
  }

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer) scanEvaluated(declaration.initializer, source, report)
      }
      continue
    }
    if (ts.isExpressionStatement(statement)) {
      scanEvaluated(statement.expression, source, report)
      continue
    }
    if (ts.isExportAssignment(statement)) {
      scanEvaluated(statement.expression, source, report)
    }
  }
  return violations
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...sourceFiles(join(dir, entry.name)))
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

describe('Worker bundle: no workerd-hostile work at module scope (#523 review B2)', () => {
  it('evaluates no randomness, timers or IO while the bundle loads', () => {
    const files = sourceFiles(BACKEND_SRC)
    // The walk must actually see the tree; an empty scan would prove nothing.
    expect(files.length).toBeGreaterThan(50)

    const violations = files.flatMap(scanFile)
    const detail = violations
      .map((v) => `  ${v.file}:${v.line} — ${v.construct} (${v.snippet})`)
      .join('\n')
    expect(
      violations,
      violations.length === 0
        ? ''
        : `module-scope work that workerd forbids during bundle evaluation:\n${detail}\n\n` +
            'Move it inside the function/handler that uses it: workerd refuses randomness,\n' +
            'timers and IO in the global scope, and one such call stops the whole Worker.'
    ).toEqual([])
  })
})
