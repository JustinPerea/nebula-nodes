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
const MAX_ENTRY_BYTES = 512_000;
const MAX_ENTRY_GZIP_BYTES = 160_000;

if (entrySize > MAX_ENTRY_BYTES || entryGzipSize > MAX_ENTRY_GZIP_BYTES) {
  throw new Error(
    `Initial entry exceeds budget: ${entrySize} bytes raw / ${entryGzipSize} bytes gzip ` +
    `(limits ${MAX_ENTRY_BYTES} / ${MAX_ENTRY_GZIP_BYTES})`,
  );
}

// The entry alone is not the startup cost: chunks it imports statically or
// modulepreloads load before the first paint too. Measured on main with
// `npm run build` (1,885,863 / 488,271 once jszip loaded on download); the
// limits are that plus about 8 KB raw / 3.5 KB gzip. Raise
// them only with the reason in the PR (the same rule as the entry limits).
const MAX_STARTUP_BYTES = 1_894_000;
const MAX_STARTUP_GZIP_BYTES = 492_000;
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
