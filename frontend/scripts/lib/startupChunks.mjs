import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

/**
 * The chunks a built page loads before anything runs: the entry script, every
 * chunk the index.html modulepreloads, and every chunk those import statically
 * (`import"./x.js"`, `import{a}from"./x.js"`, `export*from"./x.js"`), followed
 * transitively and safe against cycles. Dynamic `import("./x.js")` targets and
 * Vite's `__vite__mapDeps` lists are NOT startup: they load on demand.
 */

const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["']\.\/([^"'\\\s]+\.js)["']/g;
const MODULEPRELOAD = /<link\b[^>]*\brel=["']modulepreload["'][^>]*>/g;
const HREF = /\bhref=["']([^"']+)["']/;
const ENTRY_SCRIPT = /<script[^>]+src="(?:\/|\.\/)assets\/(index-[^"]+\.js)"/;

/** Asset file names (relative to assets/) that a chunk imports statically. */
export function staticImportsOf(source) {
  const names = new Set();
  for (const match of source.matchAll(STATIC_IMPORT)) names.add(match[1]);
  return [...names];
}

/** Asset file names index.html modulepreloads. */
export function modulepreloadsOf(indexHtml) {
  const names = new Set();
  for (const tag of indexHtml.matchAll(MODULEPRELOAD)) {
    const href = tag[0].match(HREF)?.[1];
    const name = href?.match(/(?:^|\/)assets\/([^/?#]+\.js)(?:[?#]|$)/)?.[1];
    if (name) names.add(name);
  }
  return [...names];
}

export function entryNameOf(indexHtml) {
  return indexHtml.match(ENTRY_SCRIPT)?.[1] ?? null;
}

/**
 * Walk the startup set of a dist folder. Returns members as
 * { name, raw, gzip } plus totals, biggest first.
 */
export async function startupSet(distDir) {
  const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
  const entry = entryNameOf(indexHtml);
  if (!entry) throw new Error(`Could not identify the production entry script in ${path.basename(distDir)}/index.html`);

  const seen = new Map();
  const queue = [entry, ...modulepreloadsOf(indexHtml)];
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    const bytes = await readFile(path.join(distDir, 'assets', name));
    seen.set(name, { name, raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength });
    for (const next of staticImportsOf(bytes.toString('utf8'))) if (!seen.has(next)) queue.push(next);
  }

  const members = [...seen.values()].sort((a, b) => b.raw - a.raw);
  return {
    entry,
    members,
    raw: members.reduce((sum, m) => sum + m.raw, 0),
    gzip: members.reduce((sum, m) => sum + m.gzip, 0),
  };
}

/** Chunk names without their content hash, so reports read the same build to build. */
export function chunkLabel(name) {
  return name.replace(/-[A-Za-z0-9_-]{8}\.js$/, '.js');
}
