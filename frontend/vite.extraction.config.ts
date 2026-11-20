import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

/** The extraction page: its own entry (extraction.html) and its own out folder, so the app's
 * startup bundle never sees it. `python -m extraction serve` serves dist-extraction; with
 * `--dev` the page comes from this dev server (port 5870) and /api goes to that server (8870).
 * The proxy keeps the browser's Host and Origin, which the server accepts for the dev port. */
export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist-extraction',
    emptyOutDir: true,
    rolldownOptions: {
      input: fileURLToPath(new URL('./extraction.html', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5870,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8870', changeOrigin: false },
      // This dev server has no index.html, so the page's own address serves the extraction entry.
      '^/$': { target: 'http://127.0.0.1:5870', bypass: () => '/extraction.html' },
    },
  },
})
