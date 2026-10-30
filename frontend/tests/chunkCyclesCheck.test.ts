// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sparkImportCycles, staticChunkImports } from '../scripts/check-chunk-cycles.mjs';

/**
 * scripts/check-chunk-cycles.mjs runs after every `vite build` (from
 * check-build-budget.mjs): no chunk Spark loads may load Spark back.
 */

describe('staticChunkImports', () => {
  it('reads minified imports and re-exports of sibling chunks', () => {
    const source = 'import{t as e}from"./a.js";import"./b.js";export{n as r}from"./c.js";'
      + 'export*from"./d.js";export * as ns from \'./e.js\';const x=1;export{x};';
    expect(staticChunkImports(source)).toEqual(['a.js', 'b.js', 'c.js', 'd.js', 'e.js']);
  });

  it('skips dynamic imports, plain exports and other origins', () => {
    const source = 'const m=()=>import("./lazy.js");export{a as b};import"https://cdn.example/x.js";';
    expect(staticChunkImports(source)).toEqual([]);
  });
});

describe('sparkImportCycles', () => {
  it('finds a cycle made only by a re-export', () => {
    const chunks = new Map([
      ['spark-vendor-1.js', 'import{F as q}from"./three-pass.js";'],
      ['three-pass.js', 'export{S as s}from"./spark-vendor-1.js";'],
    ]);
    expect(sparkImportCycles(chunks)).toEqual([{ spark: 'spark-vendor-1.js', back: ['three-pass.js'] }]);
  });

  it('passes a Spark chunk that only imports one way', () => {
    const chunks = new Map([
      ['spark-vendor-1.js', 'import{F as q}from"./three-pass.js";'],
      ['three-pass.js', 'export{F as f}from"./three.js";'],
      ['three.js', 'const F=1;export{F};'],
      ['WorldEnvironmentViewer-2.js', 'import{x}from"./spark-vendor-1.js";'],
    ]);
    expect(sparkImportCycles(chunks)).toEqual([]);
  });
});
