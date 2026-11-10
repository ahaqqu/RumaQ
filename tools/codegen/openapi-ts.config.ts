import { defineConfig } from '@hey-api/openapi-ts'

/**
 * Typed API client generation for the frontend.
 *
 * Runs from tools/codegen, which owns the JavaScript TypeScript compiler this
 * generator needs (`ts.factory` / `ts.SyntaxKind`): hey-api has no compiler of
 * its own and resolves the app's `typescript`, which is the native compiler
 * (7.x) and ships none of that API. Keeping the generator in a workspace with
 * a pinned 5.9.3 compiler is what lets the root tree stay on TypeScript 7.
 *
 * The output is committed: CI regenerates it and fails on any diff, so backend
 * route drift cannot reach the client silently.
 */
export default defineConfig({
  input: '../../frontend/openapi.json',
  output: {
    path: '../../frontend/src/lib/api-client',
  },
  plugins: [
    '@hey-api/typescript',
    '@hey-api/sdk',
    { name: '@hey-api/client-fetch', bundle: false },
  ],
})
