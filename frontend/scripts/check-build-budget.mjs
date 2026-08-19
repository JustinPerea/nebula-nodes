import { readFile, readdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '../dist');
const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
const entryMatch = indexHtml.match(/<script[^>]+src="\/assets\/(index-[^"]+\.js)"/);

if (!entryMatch) {
  throw new Error('Could not identify the production entry script in dist/index.html');
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

const assetNames = await readdir(path.join(distDir, 'assets'));
for (const assetName of assetNames.filter((name) => name.endsWith('.js'))) {
  const source = await readFile(path.join(distDir, 'assets', assetName), 'utf8');
  if (source.includes('eval(') || source.includes('new Function(')) {
    throw new Error(`Runtime code generation found in production asset: ${assetName}`);
  }
}

console.log(
  `Build budget passed: ${entrySize} bytes raw / ${entryGzipSize} bytes gzip; ` +
  `${assetNames.filter((name) => name.endsWith('.js')).length} JavaScript assets are eval-free.`,
);
