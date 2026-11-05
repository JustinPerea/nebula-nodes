// Dev-only code never ships (GM r49): the ?cursorStates=1 driver
// (src/components/canvas/agentCursorStatesDriver.ts) is imported behind
// import.meta.env.DEV, so a production build drops it. This fails the build
// if its marker, or its module's name, reaches any built asset.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, process.env.NEBULA_DESKTOP_BUILD === '1' ? '../dist-desktop' : '../dist');
const MARKERS = ['nebula-cursor-states-driver', 'agentCursorStatesDriver', 'startCursorStatesDriver', 'nebulaCursorStates'];

const assetsDir = path.join(distDir, 'assets');
const names = (await readdir(assetsDir)).filter((name) => /\.(?:js|mjs|map|html)$/.test(name));
if (names.length === 0) throw new Error(`No built assets in ${assetsDir}`);
const found = [];
for (const name of [...names.map((n) => path.join(assetsDir, n)), path.join(distDir, 'index.html')]) {
  const text = await readFile(name, 'utf8');
  for (const marker of MARKERS) if (text.includes(marker)) found.push(`${path.relative(distDir, name)}: ${marker}`);
}
if (found.length) {
  throw new Error(`Dev-only code reached the production build:\n${found.join('\n')}`);
}
console.log(`Dev-only check passed: none of ${MARKERS.length} dev-only markers in ${names.length} built assets.`);
