/**
 * `build.assetsInlineLimit` for vite.config.ts.
 *
 * Vite inlines any asset under 4 KiB as a base64 data: URL. The bundled fonts
 * (src/assets/fonts/) include subsets smaller than that, and an inlined font
 * is downloaded with its stylesheet whether or not the page uses that subset,
 * which defeats unicode-range. Fonts always stay files; everything else keeps
 * Vite's default rule (returning undefined).
 */
export function inlineAssetUnlessFont(filePath: string): false | undefined {
  return /\.woff2?(?:[?#].*)?$/i.test(filePath) ? false : undefined
}
