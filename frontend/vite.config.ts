import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const lottieLightPath = fileURLToPath(
  new URL('./node_modules/lottie-web/build/player/lottie_light.js', import.meta.url),
)

/** Spark's generic PLY reader probes and optionally builds a parser with
 * `new Function`; it already falls back to its ordinary dynamic parser when
 * CSP blocks that optimization. Nebula loads only preflighted SPZ files in the
 * World viewer, and its production policy forbids runtime code generation in
 * every chunk. Replace both the main-thread probe and Spark's embedded worker
 * source with a throwing call so the library deterministically selects its
 * documented fallback path. Keep the post-build scanner as the proof boundary. */
function sparkWithoutRuntimeCodegen() {
  const marker = 'new Function('
  const disabledCall = '((..._nebulaRuntimeCodegenArgs) => { throw new Error("Runtime code generation disabled by Nebula"); })('
  return {
    name: 'nebula-spark-no-runtime-codegen',
    enforce: 'pre' as const,
    transform(code: string, rawId: string) {
      const id = rawId.split('?', 1)[0].replaceAll('\\', '/')
      if (!id.endsWith('/@sparkjsdev/spark/dist/spark.module.js')) return null
      const occurrences = code.split(marker).length - 1
      if (occurrences < 2) {
        throw new Error('Spark runtime-codegen markers changed; review the pinned dependency before building.')
      }
      return { code: code.replaceAll(marker, disabledCall), map: null }
    },
  }
}

export default defineConfig({
  // Electron loads the packaged renderer through file://. Relative asset URLs
  // keep chunks, styles, and static files resolvable from that origin.
  base: process.env.NEBULA_DESKTOP_BUILD === '1' ? './' : '/',
  plugins: [sparkWithoutRuntimeCodegen(), react()],
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
              // Stable startup frameworks are shared by Canvas and the lazy
              // workspaces. Isolating them keeps feature growth measurable in
              // the entry budget and gives browsers one long-lived vendor
              // cache instead of rebundling React into index.*.
              name: 'react-vendor',
              test: /node_modules[\\/](?:react|react-dom|scheduler|zustand|use-sync-external-store)[\\/]/,
              priority: 40,
              maxSize: 450_000,
            },
            {
              name: 'canvas-vendor',
              test: /node_modules[\\/]@xyflow[\\/]/,
              priority: 30,
              maxSize: 450_000,
            },
            {
              name: 'archive-vendor',
              test: /node_modules[\\/]jszip[\\/]/,
              priority: 30,
            },
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
            {
              // Spark's renderer/worker payload is only needed after a user
              // expands a World. Keep it isolated from both the startup entry
              // and the reusable React Three Fiber chunk.
              name: 'spark-vendor',
              test: /node_modules[\\/]@sparkjsdev[\\/]spark[\\/]/,
              priority: 30,
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
