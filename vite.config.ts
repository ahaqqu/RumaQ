import { defineConfig } from 'vite-plus'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  check: {
    fmt: true,
    lint: true,
  },
  fmt: {
    // Vendored/generated code, kept byte-for-byte as its tool emitted it:
    // · security-audit skill is vendored verbatim from cloudflare
    // · api-client is emitted by hey-api (`bun run api:codegen`); CI diffs it
    ignorePatterns: ['.agents/skills/security-audit/**', 'frontend/src/lib/api-client/**'],
    semi: false,
    singleQuote: true,
    trailingComma: 'es5',
    overrides: [
      {
        files: ['**/*.sh'],
        formatter: 'prettier',
      },
    ],
  },
  lint: {
    // Vendored/generated code excluded here too (see fmt above). The generated
    // client is still type-checked where it matters: its types flow into
    // src/lib/api.ts, which is linted.
    ignorePatterns: ['.agents/skills/security-audit/**', 'frontend/src/lib/api-client/**'],
    options: {
      // typeAware + typeCheck make `vp check` the single static-check pass:
      // format + lint + full type-check (tsgolint / TypeScript Go).
      typeAware: true,
      typeCheck: true,
    },
    plugins: ['import'],
    rules: {
      'import/no-default-export': 'error',
      'import/no-anonymous-default-export': 'error',
      // Treat unused identifiers as hard errors so CI blocks them.
      'no-unused-vars': 'error',
    },
    overrides: [
      {
        files: ['backend/src/index.ts'],
        rules: {
          'import/no-default-export': 'off',
          'import/no-anonymous-default-export': 'off',
        },
      },
      {
        files: ['**/*.config.{js,ts,mjs,cjs}', 'automation/**/*.mjs', 'automation/**/*.js'],
        rules: {
          'import/no-default-export': 'off',
          'import/no-anonymous-default-export': 'off',
        },
      },
    ],
  },
  resolve: {
    alias: {
      'virtual:pwa-register/react': path.resolve(
        __dirname,
        'frontend/src/__mocks__/virtual-pwa-register-react.js'
      ),
    },
  },
  run: {
    tasks: {
      // Regenerates the typed API client inputs. Never cached: CI diffs the
      // committed artifacts to fail on backend route drift.
      //
      // The generator (hey-api/openapi-ts) builds its output through the
      // TypeScript compiler API (`ts.factory`, `ts.SyntaxKind`), which the
      // native compiler (typescript@7) no longer ships — it resolves the app's
      // `typescript` and dies on TS 7 even though its peer range admits 7. So
      // it lives in tools/codegen, which pins its own 5.9.3 compiler: the root
      // tree stays on 7 and the generator keeps its JS API. The emitted
      // frontend/src/lib/api-client is committed (and lint/fmt-ignored) so CI's
      // drift check can fail on backend route drift.
      'api:codegen': {
        command:
          'bunx tsx scripts/api/generate-openapi-spec.ts && bun run --cwd tools/codegen generate && bunx vp fmt --write frontend/openapi.json',
        cache: false,
      },
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'frontend',
          root: 'frontend',
          environment: 'jsdom',
          // jsdom environment creation dominates the suite (~60% of tracked
          // time: one fresh jsdom per file under the default forks pool).
          // vmThreads creates it once per worker and reuses it for every file
          // that worker runs — vitest disables per-file isolation for vm
          // pools (isolate is forced off), so globals and the module registry
          // are shared across a worker's file batch; only mocks are reset
          // between files. Verified leak-free for this suite (green under
          // --sequence.shuffle.filesOnly), but new tests must not rely on
          // fresh per-file global/module state. Scoped to this project only;
          // the backend is a node env and gains nothing.
          // Exception: under vmThreads the jsdom window IS the VM global, so
          // its unforgeable `window.location` cannot be redefined — api.test.js
          // stubs it and therefore runs in the `frontend-dom` project below
          // on the default forks pool, where vitest's copied globals stay
          // redefinable (issue #351).
          pool: 'vmThreads',
          include: ['src/**/*.test.{js,jsx}'],
          exclude: ['**/node_modules/**', '**/dist/**', 'src/lib/api.test.js'],
          setupFiles: ['src/test-setup.js'],
          testTimeout: 15000,
        },
      },
      {
        extends: true,
        test: {
          name: 'frontend-dom',
          root: 'frontend',
          environment: 'jsdom',
          include: ['src/lib/api.test.js'],
          setupFiles: ['src/test-setup.js'],
          testTimeout: 15000,
        },
      },
      {
        extends: true,
        test: {
          name: 'backend',
          root: 'backend',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          testTimeout: 15000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          include: ['automation/tests/local/api/steps/**/*.steps.js'],
          envDir: 'automation/tests',
          testTimeout: 30_000,
          fileParallelism: false,
          reporters: [
            ['default', { verbose: true }],
            ['json', { outputFile: 'vitest-report/api-results.json' }],
          ],
        },
      },
    ],
  },
  coverage: {
    exclude: [
      'frontend/src/styles/**',
      'frontend/src/routes/**',
      'frontend/src/lib/queries/**',
      'frontend/src/context/AppContext.jsx',
      'frontend/src/lib/cn.js',
    ],
    thresholds: {
      statements: 50,
      branches: 50,
      functions: 50,
      lines: 50,
    },
  },
})
