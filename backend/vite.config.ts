import { defineConfig, type PluginOption } from 'vite-plus'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  // `cloudflare()` returns `vite.Plugin[]` from the standalone `vite` package,
  // while vite-plus types this config with its vendored Vite core — both are
  // Vite 8.1.5, but TS 7's structural comparison of the two recursive Plugin
  // types gives up ("excessive stack depth"). Assert at the boundary: the
  // value is a plain array of Vite plugins. Revisit when vite-plus re-exports
  // plugin-compatible types or Bun links the plugin's vite peer to its core.
  plugins: cloudflare() as PluginOption[],
  publicDir: '../frontend/dist',
  // The Cloudflare plugin serves the Worker through the Vite dev server
  // (no separate wrangler port since v2). Keep the historical worker port so
  // the frontend proxy, VITE_API_BASE and tooling keep working.
  server: {
    port: 8787,
    strictPort: true,
  },
})
