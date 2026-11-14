import { readFile, readdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBuiltFonts } from './check-built-fonts.mjs';
import { sparkImportCycles } from './check-chunk-cycles.mjs';
import { chunkLabel, startupSet } from './lib/startupChunks.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, process.env.NEBULA_DESKTOP_BUILD === '1' ? '../dist-desktop' : '../dist');
const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
const entryMatch = indexHtml.match(/<script[^>]+src="(?:\/|\.\/)assets\/(index-[^"]+\.js)"/);

// Electron loads the desktop bundle over file://, where a root-absolute
// /assets/... URL points at the filesystem root and nothing mounts.
if (process.env.NEBULA_DESKTOP_BUILD === '1' && /(?:src|href)="\/(?!\/)/.test(indexHtml)) {
  throw new Error('Desktop build has root-absolute asset URLs; it must be built with base "./"');
}

if (!entryMatch) {
  throw new Error(`Could not identify the production entry script in ${path.basename(distDir)}/index.html`);
}

const entryPath = path.join(distDir, 'assets', entryMatch[1]);
const entryBytes = await readFile(entryPath);
const entrySize = (await stat(entryPath)).size;
const entryGzipSize = gzipSync(entryBytes).byteLength;
// Measured 2026-11-14 after the startup-set defer (docs/notes/2026-11-14-perf-startup-set-defer.md):
// 394,268 raw / 125,652 gzip, down from 477,203 / 148,357. Merging main (417a238b) took the
// entry to 399,592 / 127,624 (+5,324 / +1,972). Design round 1 (the fallback card, the reveal
// and the hold line) added +5,686 / +1,705: 405,278 / 129,329. Review round 1 (the hold's
// ceiling, the owed fit, the swap marks, the live region) added +650 / +274: 405,928 / 129,603.
// The limits are that plus 8,000 raw / 3,500 gzip, rounded up to the next 100.
const MAX_ENTRY_BYTES = 414_000;
const MAX_ENTRY_GZIP_BYTES = 133_200;

if (entrySize > MAX_ENTRY_BYTES || entryGzipSize > MAX_ENTRY_GZIP_BYTES) {
  throw new Error(
    `Initial entry exceeds budget: ${entrySize} bytes raw / ${entryGzipSize} bytes gzip ` +
    `(limits ${MAX_ENTRY_BYTES} / ${MAX_ENTRY_GZIP_BYTES})`,
  );
}

// The entry alone is not the startup cost: chunks it imports statically or
// modulepreloads load before the first paint too. Measured with `npm run build`
// after the 2026-11-14 defer: 1,841,464 raw / 481,238 gzip in 44 chunks (it was
// 1,923,389 / 502,295 in 40). After merging main and the later rounds it was
// 1,847,267 / 483,364; design round 1 added +5,686 / +1,704 (1,852,953 / 485,068);
// review round 1 added +650 / +275: 1,853,603 / 485,343, still 44 chunks. The limits
// are that plus 8,000 raw / 3,500 gzip, rounded up to the next 1,000 raw and 100 gzip.
// What left the set: the node cards for the less common
// kinds (Edit, Remotion, Cinema scene, Character, Camera rig, Reference set,
// Moodboard, Paper source, Batch, Dynamic), the Jev, spatial/world and
// structured result views a finished card draws, and the canvas's arrange
// controller; each loads on idle after the first paint (lib/deferredChunks.ts).
// The two biggest members stay: the node definitions (534 KB, read
// synchronously by graphStore, keptWires and every card) and graphStore. Raise
// the limits only with the reason in the PR (the same rule as the entry limits).
// PR #199 (project catalog backup) added +33,454 raw / +12,309 gzip by its own
// measured cost: a canvas kept in the tab after a restore is only in that tab,
// so what keeps it safe loads with the app (the kept unload guard and fallback
// line, the kept edit steps in graphStore, keptWires' refusals, Projects home's
// kept notice, the bottom bar's kept state). Its round 28 notes measured lazy
// splits of these; a kept edit that waits for a chunk is refused for good when
// that chunk can't load, which is when a canvas is kept, so they stay.
const MAX_STARTUP_BYTES = 1_862_000;
const MAX_STARTUP_GZIP_BYTES = 488_900;
const startup = await startupSet(distDir);
const biggest = startup.members.slice(0, 5).map((m) => `${chunkLabel(m.name)} ${m.raw}`).join(', ');

if (startup.raw > MAX_STARTUP_BYTES || startup.gzip > MAX_STARTUP_GZIP_BYTES) {
  throw new Error(
    `Startup set exceeds budget: ${startup.raw} bytes raw / ${startup.gzip} bytes gzip across ${startup.members.length} chunks ` +
    `(limits ${MAX_STARTUP_BYTES} / ${MAX_STARTUP_GZIP_BYTES}). Biggest members: ${biggest}`,
  );
}

const assetNames = await readdir(path.join(distDir, 'assets'));
for (const assetName of assetNames.filter((name) => name.endsWith('.js'))) {
  const source = await readFile(path.join(distDir, 'assets', assetName), 'utf8');
  if (source.includes('eval(') || source.includes('new Function(')) {
    throw new Error(`Runtime code generation found in production asset: ${assetName}`);
  }
}

// Spark must not share an import cycle with another chunk (check-chunk-cycles.mjs says why).
const jsChunks = new Map();
for (const name of assetNames.filter((asset) => asset.endsWith('.js'))) {
  jsChunks.set(name, await readFile(path.join(distDir, 'assets', name), 'utf8'));
}
for (const { spark, back } of sparkImportCycles(jsChunks)) {
  throw new Error(`${spark} is in an import cycle with ${back.join(', ')}; Spark would run before what it imports`);
}

// The app ships its own fonts; nothing in the build may ask a font CDN.
const fonts = await checkBuiltFonts(distDir, { desktop: process.env.NEBULA_DESKTOP_BUILD === '1' });

console.log(
  `Build budget passed: entry ${entrySize} bytes raw / ${entryGzipSize} bytes gzip; ` +
  `startup set ${startup.raw} raw / ${startup.gzip} gzip in ${startup.members.length} chunks (biggest: ${biggest}); ` +
  `${assetNames.filter((name) => name.endsWith('.js')).length} JavaScript assets are eval-free; ` +
  `${fonts.fontFiles} bundled woff2 files (${fonts.fontBytes} bytes) behind ${fonts.faces} @font-face rules, no font CDN.`,
);
