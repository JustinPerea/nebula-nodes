// The import-cycle half of check-build-budget.mjs, split out so a test can feed it
// small fake chunks (tests/chunkCyclesCheck.test.ts).
//
// Spark builds three objects at module top level (a FullScreenQuad from
// three's Pass.js). If a chunk Spark imports also imports Spark, the cycle can
// run Spark before that chunk defines them, and every World viewer fails with
// "FullScreenQuad is not a constructor" (2026-10-29; vite.config.ts keeps
// Pass.js in spark-vendor). Static imports only: a re-export
// (`export{t as a}from"./x.js"`, `export*from"./x.js"`) loads its module
// just as an import does, so it counts too (PR #203 review).

/** The sibling chunks a minified chunk loads statically: `import{t as e}from"./x.js";`,
 * `import"./x.js";`, `export{t as a}from"./x.js";` and `export*from"./x.js";`, anywhere on a line. */
export function staticChunkImports(source) {
  return [...source.matchAll(/\b(?:import|export)\s*(?:[\w${},*\s]+?\s*from\s*)?["']\.\/([^"']+\.js)["']/g)]
    .map((match) => match[1]);
}

/** Each Spark chunk with the other chunks it shares an import cycle with.
 * `chunks` maps a chunk's file name to its source. */
export function sparkImportCycles(chunks, isSpark = (name) => name.startsWith('spark-vendor')) {
  const imports = new Map([...chunks].map(([name, source]) => [name, staticChunkImports(source)]));
  const reachable = (start) => {
    const seen = new Set();
    const stack = [...(imports.get(start) ?? [])];
    while (stack.length) {
      const next = stack.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(imports.get(next) ?? []));
    }
    return seen;
  };
  const sparkChunks = [...imports.keys()].filter(isSpark);
  return sparkChunks
    .map((spark) => ({
      spark,
      back: [...reachable(spark)].filter((name) => !sparkChunks.includes(name) && reachable(name).has(spark)),
    }))
    .filter(({ back }) => back.length > 0);
}
