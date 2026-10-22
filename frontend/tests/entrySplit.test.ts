// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DEFERRED_MODULES } from '../src/lib/deferredChunks';

/**
 * Guard for the startup entry budget (scripts/check-build-budget.mjs).
 *
 * The modules in DEFERRED_MODULES are loaded with dynamic import() so they stay
 * out of assets/index-*.js. One static `import` anywhere on the startup path
 * would silently pull a module (and everything it imports) back into the
 * entry. This walks the static import graph from src/main.tsx the way the
 * bundler does: `import type` / `export type` are erased, dynamic import() is
 * a split point, and everything else (including `import { type X }`, which
 * verbatimModuleSyntax keeps as a side-effect import) is an edge. Startup
 * helpers such as lib/representationViewerRegistry.ts and lib/structuredValue.ts
 * are on this path, so a viewer import from them fails here too.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // packages are not ours to police here
  const bare = specifier.split('?', 1)[0];
  if (/\.(css|svg|png|jpe?g|webp|json)$/.test(bare)) return null;
  const base = path.resolve(path.dirname(fromFile), bare);
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** Every local module reachable by static imports, with one importer chain for each. */
function startupGraph(entry: string): Map<string, string[]> {
  const chains = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of staticImports(file)) {
      const target = resolveLocal(file, specifier);
      if (!target || chains.has(target)) continue;
      chains.set(target, [...chains.get(file)!, target]);
      queue.push(target);
    }
  }
  return chains;
}

const STARTUP_STATE = [
  'store/agentLogStore.ts',
  'store/agentNotesStore.ts',
  'store/agentPresenceStore.ts',
  'store/canvasProposalsStore.ts',
  'store/canvasPinsStore.ts',
  'lib/heldIntents.ts',
  'lib/commandPaletteKeys.ts',
];

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

describe('startup entry split', () => {
  const graph = startupGraph(path.join(SRC, 'main.tsx'));

  it('walks the real startup graph', () => {
    // If these disappear the walker is broken, not the app.
    for (const expected of ['App.tsx', 'components/Canvas.tsx', 'components/nodes/ModelNode.tsx', 'lib/deferredChunks.ts']) {
      expect(graph.has(path.join(SRC, expected)), expected).toBe(true);
    }
  });

  it.each(DEFERRED_MODULES)('%s is only reached through dynamic import()', (module) => {
    const file = path.join(SRC, module);
    expect(existsSync(file), `${module} exists`).toBe(true);
    const chain = graph.get(file);
    expect(
      chain?.map(rel).join(' -> '),
      `${module} is statically imported on the startup path; import its Deferred* wrapper instead`,
    ).toBeUndefined();
  });

  // Startup-time state a deferred piece reads: stores that subscribe to the
  // socket at import, and the listeners that hold an intent until the piece
  // is in. Moving one of these out with its panel would drop what arrives
  // before the chunk does.
  it.each(STARTUP_STATE)('%s stays in the startup entry', (module) => {
    const file = path.join(SRC, module);
    expect(existsSync(file), `${module} exists`).toBe(true);
    expect(graph.has(file), `${module} must be imported eagerly (App.tsx or another startup module)`).toBe(true);
  });

});
