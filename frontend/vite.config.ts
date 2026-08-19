import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const lottieLightPath = fileURLToPath(
  new URL('./node_modules/lottie-web/build/player/lottie_light.js', import.meta.url),
)

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The full player bundles its expression interpreter with runtime code
    // generation. Nebula only renders SVG Lottie animations, so the light
    // player removes that unsafe-eval path and its production-build warning.
    alias: {
      'lottie-web': lottieLightPath,
    },
  },
  build: {
    // Three.js ships as one indivisible ~717 kB module, but it is only fetched
    // by lazy 3D workspaces. Track the initial entry with a stricter dedicated
    // budget instead of treating this deferred module as startup payload.
    chunkSizeWarningLimit: 750,
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            {
              name: 'remotion-vendor',
              test: /node_modules[\\/](?:@remotion|remotion)[\\/]/,
              priority: 20,
              maxSize: 450_000,
            },
            {
              name: 'timeline-vendor',
              test: /node_modules[\\/]@xzdarcy[\\/]/,
              priority: 20,
              maxSize: 450_000,
            },
            {
              name: 'lottie-vendor',
              test: /node_modules[\\/]lottie-web[\\/]/,
              priority: 30,
            },
            {
              name: 'react-three-vendor',
              test: /node_modules[\\/]@react-three[\\/]/,
              priority: 20,
              maxSize: 450_000,
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})
