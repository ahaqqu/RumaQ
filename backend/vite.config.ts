import { defineConfig } from 'vite-plus'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [
    cloudflare({
      configPath: './wrangler.test.toml',
    }),
  ],
})
