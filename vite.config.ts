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
    semi: false,
    singleQuote: true,
    trailingComma: 'es5',
    // Verbatim scraped-site fixtures are test data, not source to format.
    ignorePatterns: ['scraper/test/fixtures/**'],
    overrides: [
      {
        files: ['**/*.sh'],
        formatter: 'prettier',
      },
    ],
  },
  lint: {
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
      'api:codegen': {
        command:
          'bunx tsx scripts/api/generate-openapi-spec.ts && node node_modules/openapi-typescript/bin/cli.js frontend/openapi.json -o frontend/src/lib/api-schema.d.ts && bunx vp fmt --write frontend/openapi.json frontend/src/lib/api-schema.d.ts',
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
          // vmThreads creates it per worker and keeps per-file isolation —
          // vitest's own suggestion for this exact profile. Scoped to this
          // project only; backend/scraper are node envs and gain nothing.
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
          name: 'scraper',
          root: 'scraper',
          environment: 'node',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
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
