// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DEFERRED_MODULES } from '../src/lib/deferredChunks';

/**
 * Phase 3's entry budget: the DOM attributes' helper is the only part of the
 * anchor machinery the entry carries (the rail, the header and the Moodboard
 * node use it), and it imports nothing; the resolver and the layer rule ride
 * the cursor chunk (entrySplit.test.ts keeps every DEFERRED_MODULES entry out
 * of the startup graph).
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');

describe('lib/agentAnchors.ts', () => {
  it('imports nothing and re-exports nothing, type-only or not', () => {
    const source = ts.createSourceFile('agentAnchors.ts', read('lib/agentAnchors.ts'), ts.ScriptTarget.Latest, false);
    const edges = source.statements.filter((s) => ts.isImportDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier));
    expect(edges.map((s) => s.getText(source))).toEqual([]);
    expect(read('lib/agentAnchors.ts')).not.toMatch(/\bimport\s*\(/);
  });

  it('stays in the entry, while the resolver and the layer rule are in the cursor chunk', () => {
    expect(DEFERRED_MODULES).not.toContain('lib/agentAnchors.ts');
    expect(DEFERRED_MODULES).toContain('lib/agentAnchorResolve.ts');
    expect(DEFERRED_MODULES).toContain('lib/agentCursorLayerOf.ts');
  });

  it('the resolver reads rects only: no scrolling, panning, opening or focusing', () => {
    const code = read('lib/agentAnchorResolve.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/scrollIntoView|scrollTo|scrollTop\s*=|setViewport|setCenter|fitView|\.click\(|\.focus\(|setLeftDock|togglePanel|enter\w*Editor/);
  });
});
