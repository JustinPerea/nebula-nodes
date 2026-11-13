import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupSet } from './lib/startupChunks.mjs';

/**
 * PR #199 round 17 (GM r23, 3): a canvas kept in this tab is only here, so
 * what protects it must never wait for a lazy chunk. Two things must load
 * with the app itself (the entry chunk or a chunk the entry imports
 * statically, which the browser fetches before the entry runs), never in a
 * chunk that loads later and can fail on its own (the lazy
 * `catalogRestoreCopy` chunk, or the project flows chunk, round 25):
 * - the kept unload guard (store/projectStore.ts registers it with
 *   `window.addEventListener('beforeunload', …)` and marks its kept branch
 *   with the literal 'nebula-kept-unload-guard'), so a reload or a tab
 *   close asks first even when the copy chunk never arrived;
 * - the kept fallback line (restoreCopyCore RESTORE_COPY_FALLBACK_KEPT), the
 *   full sentence the notice says when that chunk failed while kept.
 * The bundler may place a module the entry and lazy chunks share in a common
 * chunk the entry imports instead of in the entry file itself; that is as
 * early as the entry, so it counts (round 25: it did, for projectStore).
 *
 * Run after `vite build`. The build folder: the first argument, else dist
 * (dist-desktop for the desktop build), as check-build-budget.mjs reads it.
 */
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(scriptDir, process.env.NEBULA_DESKTOP_BUILD === '1' ? '../dist-desktop' : '../dist');

/** String literals minification keeps, each in its guard's own code path. */
const MARKERS = [
  // The kept guard's own literal (store/projectStore.ts KEPT_UNLOAD_MARK),
  // beside its registration: any other beforeunload can't pass for it
  // (review 16 kept-ui NIT-2).
  { what: 'the kept unload guard', pattern: /nebula-kept-unload-guard/ },
  { what: 'the unload guard registration', pattern: /addEventListener\((["'`])beforeunload\1/ },
  // The last word is the shared tab/window word (lib/tabWord, round 20 of
  // PR #199): built as a call inside the template literal, or a literal.
  { what: 'the kept fallback line', pattern: /before your latest edits were saved\. They(?:’|\\u2019)re kept in this (?:tab|window|\$\{[\w$]+\(\)\})\./ },
];

const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
const entryMatch = indexHtml.match(/<script[^>]+src="(?:\/|\.\/)assets\/(index-[^"]+\.js)"/);
if (!entryMatch) throw new Error(`Kept guard check: no entry script in ${path.join(distDir, 'index.html')}`);
const assetNames = await readdir(path.join(distDir, 'assets'));
const lazyCopy = assetNames.filter((name) => /^catalogRestoreCopy-[^/]+\.js$/.test(name));
if (lazyCopy.length !== 1) {
  throw new Error(`Kept guard check: expected one catalogRestoreCopy chunk in ${distDir}/assets, found ${lazyCopy.length}`);
}
/** The chunks the page loads before anything runs: main's shared startup
 * walker (scripts/lib/startupChunks.mjs): the entry, the modulepreloads, and
 * every static import of those, transitively. */
const startup = await startupSet(distDir);
const loadedWithEntry = new Map();
for (const member of startup.members) {
  loadedWithEntry.set(member.name, await readFile(path.join(distDir, 'assets', member.name), 'utf8'));
}
const copy = await readFile(path.join(distDir, 'assets', lazyCopy[0]), 'utf8');
// The project flows chunk loads later, on its own (store/projectFlowsLoader).
const flowsChunks = assetNames.filter((name) => /^projectFlows-[^/]+\.js$/.test(name));
if (flowsChunks.length !== 1) {
  throw new Error(`Kept guard check: expected one projectFlows chunk in ${distDir}/assets, found ${flowsChunks.length}`);
}
const flows = await readFile(path.join(distDir, 'assets', flowsChunks[0]), 'utf8');

const failures = [];
for (const { what, pattern } of MARKERS) {
  const holders = [...loadedWithEntry].filter(([, code]) => pattern.test(code)).map(([name]) => name);
  if (holders.length === 0) failures.push(`${what} is not in the entry chunk ${entryMatch[1]} or a chunk it imports statically`);
  if (pattern.test(copy)) failures.push(`${what} is in the lazy chunk ${lazyCopy[0]}; it must load with the entry`);
  if (pattern.test(flows)) failures.push(`${what} is in the lazy chunk ${flowsChunks[0]}; it must load with the entry`);
}
if (failures.length > 0) {
  throw new Error(`Kept guard check failed (GM r23, 3): ${failures.join('; ')}.`);
}
console.log(`Kept guard check passed: the kept unload guard and the kept fallback line load with ${entryMatch[1]} (${loadedWithEntry.size} chunks statically), not in ${lazyCopy[0]} or ${flowsChunks[0]}.`);
