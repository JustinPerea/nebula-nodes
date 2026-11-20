// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The app's startup bundle has almost no headroom, and the extraction page is its own build.
// Nothing the app loads may import it, directly or by a relative path that lands in it.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const INSIDE = join(SRC, 'extraction') + sep

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(ts|tsx|js|jsx|mjs|css)$/.test(name) ? [path] : []
  })
}

/** Every module specifier in a file: static and dynamic imports, re-exports, CSS @import and url(). */
export function specifiers(source: string): string[] {
  const found: string[] = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /@import\s+(?:url\()?['"]([^'"]+)['"]/g,
    /\bnew URL\(\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1])
  return found
}

function reachesExtraction(from: string, spec: string): boolean {
  if (/(^|\/)extraction(\/|$)/.test(spec) && !spec.startsWith('.')) return true
  if (!spec.startsWith('.')) return false
  return (join(dirname(from), spec) + sep).startsWith(INSIDE) || join(dirname(from), spec) === join(SRC, 'extraction')
}

describe('the extraction page is outside the app', () => {
  const outside = files(SRC).filter((file) => !(file + sep).startsWith(INSIDE) && !file.startsWith(INSIDE))

  it('finds the app source to check', () => {
    expect(outside.length).toBeGreaterThan(100)
    expect(outside.some((file) => relative(SRC, file) === 'main.tsx')).toBe(true)
    expect(outside.some((file) => relative(SRC, file) === 'App.tsx')).toBe(true)
  })

  it('imports nothing from src/extraction outside it', () => {
    const offenders = outside.flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter((spec) => reachesExtraction(file, spec))
        .map((spec) => `${relative(SRC, file)} imports ${spec}`),
    )
    expect(offenders).toEqual([])
  })

  it('catches a relative and a bare import of the folder', () => {
    expect(reachesExtraction(join(SRC, 'main.tsx'), './extraction/App')).toBe(true)
    expect(reachesExtraction(join(SRC, 'lib/x.ts'), '../extraction/api')).toBe(true)
    expect(reachesExtraction(join(SRC, 'lib/x.ts'), '../extraction')).toBe(true)
    expect(reachesExtraction(join(SRC, 'lib/x.ts'), 'src/extraction/api')).toBe(true)
    expect(reachesExtraction(join(SRC, 'lib/x.ts'), './springs')).toBe(false)
    expect(reachesExtraction(join(SRC, 'lib/x.ts'), 'react')).toBe(false)
  })

  it('reads every kind of import specifier', () => {
    const text = `import a from './a'\nexport { b } from "../b"\nimport './c.css'\nconst d = await import('./d')\n@import "./e.css";`
    expect(specifiers(text)).toEqual(expect.arrayContaining(['./a', '../b', './c.css', './d', './e.css']))
  })
})
