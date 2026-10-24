import { defineConfig } from 'vite-plus'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [cloudflare()],
  publicDir: '../frontend/dist',
  // The Cloudflare plugin serves the Worker through the Vite dev server
  // (no separate wrangler port since v2). Keep the historical worker port so
  // the frontend proxy, VITE_API_BASE and tooling keep working.
  server: {
    port: 8787,
    strictPort: true,
  },
})
