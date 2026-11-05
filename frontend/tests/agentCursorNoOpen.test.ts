import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * "Nebula never opens or scrolls for the person" (design section 5; GM -
 * Design: the never-opens-or-scrolls ratchet). The cursor chunk that draws on
 * surfaces beside the canvas only reads rects: no scroll, no pan, no zoom, no
 * opening of a dock or an editor. This scans its source so it can't slip back.
 * The one allowed exception, later (slice 9), is the edge chip's press handler,
 * a person's action, in its own file (listed in PRESS_HANDLERS).
 */
const SRC = resolve(__dirname, '../src');
const CHUNK = [
  'components/agent-cursor/AgentScreenLayer.tsx',
  'components/agent-cursor/AgentCursorField.tsx',
  'components/canvas/AgentCursorLayer.tsx',
  'lib/agentAnchorResolve.ts',
  'lib/agentCursorSpace.ts',
  'lib/agentCursorLayerOf.ts',
  'lib/agentCursorOutlines.ts',
  'lib/agentCursorHandoff.ts',
  'lib/agentCursorPark.ts',
];
/** A person's press, in its own file, may pan (slice 9's edge chip). */
const PRESS_HANDLERS: string[] = [];
const FORBIDDEN = /scrollIntoView|scrollTo\b|scrollBy\b|scrollTop\s*[-+]?=|scrollLeft\s*[-+]?=|setViewport|setCenter|fitView|enter\w*Editor|setLeftDock|togglePanel|\.focus\(|\.click\(/;

const code = (path: string) => readFileSync(resolve(SRC, path), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the cursor chunk never opens or scrolls anything for the person', () => {
  it.each(CHUNK.filter((path) => !PRESS_HANDLERS.includes(path)))('%s reads rects only', (path) => {
    expect(code(path)).not.toMatch(FORBIDDEN);
  });

  it('knows every file the screen layer\'s chunk is made of', () => {
    for (const path of CHUNK) expect(code(path).length).toBeGreaterThan(100);
  });
});
