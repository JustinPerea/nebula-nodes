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

// The other direction. The page may use small app modules (the springs, the shared disabled-button
// sheet), but never the app's person session: lib/personSession takes a Nebula person link out of
// the address bar on load and keeps its token, and this page has its own token and no person.
// LineText reaches it through lib/errorCopy, which is why the page's notice doesn't register.
const NEVER = ['lib/personSession.ts', 'lib/errorCopy.ts', 'components/LineText.tsx']

function resolveModule(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = join(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* not this one */
    }
  }
  return null
}

/** Every source file the page's entry reaches through relative imports. */
export function reachedFrom(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.(ts|tsx)$/.test(file)) continue
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const next = resolveModule(file, spec)
      if (next && !next.includes('.test.')) queue.push(next)
    }
  }
  return seen
}

describe('the extraction page leaves the app person session out', () => {
  const reached = [...reachedFrom(join(SRC, 'extraction', 'main.tsx'))].map((file) => relative(SRC, file).split(sep).join('/'))

  it('walks the page and the app modules it does use', () => {
    expect(reached).toEqual(expect.arrayContaining(['extraction/App.tsx', 'lib/springs.ts', 'styles/disabled-buttons.css']))
  })

  it('never reaches the person session', () => {
    expect(reached.filter((file) => NEVER.includes(file))).toEqual([])
  })

  it('would catch LineText', () => {
    const viaLineText = [...reachedFrom(join(SRC, 'components', 'LineText.tsx'))].map((file) => relative(SRC, file).split(sep).join('/'))
    expect(viaLineText).toContain('lib/personSession.ts')
  })
})
