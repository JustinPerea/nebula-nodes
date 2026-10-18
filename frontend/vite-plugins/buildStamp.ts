import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades.ts'

/** Written next to index.html in dist/ and dist-desktop/. */
export const BUILD_STAMP_FILE = 'nebula-build.json'

/** The stamp's contents for a bundle built at `paramsVersion`. */
export function buildStampSource(paramsVersion: number = GRAPH_PARAMS_VERSION): string {
  return `${JSON.stringify({ paramsVersion }, null, 2)}\n`
}

/**
 * Stamp each build with the params version its bundle was compiled with.
 *
 * The desktop app runs the checkout's backend but a frontend someone built
 * earlier, so a `git pull` that raises PARAMS_VERSION leaves an old bundle in
 * front of a new backend. desktop/frontend-build.mjs reads this file at launch
 * and refuses to open a bundle whose version differs from /api/health's.
 * The number comes from the same import the bundle uses, so it can't drift.
 * Harmless on the web build, which the in-tab gate already covers.
 */
export function nebulaBuildStamp(paramsVersion: number = GRAPH_PARAMS_VERSION) {
  return {
    name: 'nebula-build-stamp',
    apply: 'build' as const,
    generateBundle(this: { emitFile: (file: { type: 'asset', fileName: string, source: string }) => unknown }) {
      this.emitFile({ type: 'asset', fileName: BUILD_STAMP_FILE, source: buildStampSource(paramsVersion) })
    },
  }
}
