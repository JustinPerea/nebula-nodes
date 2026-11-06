import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * "Nebula never opens or scrolls for the person" (design section 5; GM -
 * Design: the never-opens-or-scrolls ratchet). The cursor chunk that draws on
 * surfaces beside the canvas only reads rects: no scroll, no pan, no zoom, no
 * opening of a dock or an editor. This scans its source so it can't slip back.
 * The one allowed exception (slice 9) is the edge chip's press handler,
 * a person's action, in its own file (listed in PRESS_HANDLERS).
 */
const SRC = resolve(__dirname, '../src');
/** The chunk's entry modules: the two the app loads lazily (lib/deferredChunks.ts). */
const ENTRIES = ['components/agent-cursor/AgentScreenLayer.tsx', 'components/canvas/AgentCursorLayer.tsx'];

const IMPORT = /(?:^|\n)\s*(?:import|export)\s(?:type\s)?[^;'"]*?from\s+['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g;
/** A relative import's file under src (a .ts or .tsx, or a folder's index), or null (a stylesheet, an asset). */
function resolveImport(from: string, spec: string): string | null {
  const base = resolve(SRC, dirname(from), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx'), base]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return relative(SRC, candidate);
  }
  return null;
}

/** Every module the entries reach by static imports (a dynamic import() is another chunk). The set is derived,
 *  not listed, so a module added to the chunk's imports is scanned without anyone remembering to add it. */
function importGraph(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(resolve(SRC, file), 'utf8').matchAll(IMPORT)) {
      const next = resolveImport(file, (match[1] ?? match[2]) as string);
      if (next) stack.push(next);
    }
  }
  return [...seen].sort();
}
const CHUNK = importGraph(ENTRIES);
/** Shared app modules the chunk reaches only through the stores and helpers it reads (they hold app code of their
 *  own that opens things for the person, never called from the cursor code). Each is named with why; anything
 *  else the graph reaches is scanned. */
const SHARED_APP_CODE: Readonly<Record<string, string>> = {
  'lib/viewportSpring.ts': 'the camera spring: the chip press\'s pan (PRESS_HANDLERS) uses it, nothing else here',
  'lib/graphFileShared.ts': 'graph file helpers, reached through graphStore',
  'lib/jobNotifications.ts': 'job notifications, reached through graphStore',
  'store/boardCanvasStore.ts': 'the Board view\'s own store; its viewport setter is the Studio\'s',
  'store/uiStore.ts': 'the UI store, which owns the dock and editor openers the cursor code never calls',
};
/** A person's press, in its own file, may pan (slice 9's edge chip). */
const PRESS_HANDLERS: string[] = ['lib/agentChipPress.ts'];
const FORBIDDEN = /scrollIntoView|scrollTo\b|scrollBy\b|scrollTop\s*[-+]?=|scrollLeft\s*[-+]?=|setViewport|springViewport|panZoom|setCenter|fitView|enter\w*Editor|setLeftDock|togglePanel|\.focus\(|\.click\(/;

const code = (path: string) => readFileSync(resolve(SRC, path), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the cursor chunk never opens or scrolls anything for the person', () => {
  const scanned = CHUNK.filter((path) => !PRESS_HANDLERS.includes(path) && !(path in SHARED_APP_CODE));

  it.each(scanned)('%s reads rects only', (path) => {
    expect(code(path)).not.toMatch(FORBIDDEN);
  });

  it('the chip\'s press is the one pan: only agentChipPress.ts springs the camera, and only CanvasEdgeChips.tsx imports it', () => {
    const own = CHUNK.filter((path) => !(path in SHARED_APP_CODE));
    const panning = own.filter((path) => /springViewport|panZoom|setViewport/.test(code(path)));
    expect(panning).toEqual(PRESS_HANDLERS);
    const importers = CHUNK.filter((path) => /agentChipPress/.test(code(path)));
    expect(importers).toEqual(['components/canvas/CanvasEdgeChips.tsx']);
  });

  it('is derived from the real import graph: the entries, their modules, and the ones the old list never named', () => {
    for (const entry of ENTRIES) expect(CHUNK).toContain(entry);
    for (const path of ['lib/agentCursorMotion.ts', 'lib/agentCursorSays.ts', 'lib/agentCursorField.ts', 'lib/agentCursorPlanner.ts',
      'lib/agentCursorSettled.ts', 'lib/springs.ts', 'lib/personNodeMoves.ts', 'lib/agentEdgeChips.ts', 'lib/agentChipChrome.ts']) {
      expect(CHUNK, path).toContain(path);
    }
    // Every exemption is still in the graph and still has something to exempt: a stale one is a hole.
    for (const path of Object.keys(SHARED_APP_CODE)) expect(CHUNK, path).toContain(path);
  });
});
