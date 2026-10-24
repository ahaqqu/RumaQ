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
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'frontend',
          root: 'frontend',
          environment: 'jsdom',
          include: ['src/**/*.test.{js,jsx}'],
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
