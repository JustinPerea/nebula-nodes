import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PR #199 round 17 (GM r23, 3): a canvas kept in this tab is only here, so
 * what protects it must never wait for a lazy chunk. Two things must be in
 * the entry chunk, never in the lazy `catalogRestoreCopy` chunk (a chunk
 * that fails to load would take them with it):
 * - the kept unload guard (store/projectStore.ts registers it with
 *   `window.addEventListener('beforeunload', …)` and marks its kept branch
 *   with the literal 'nebula-kept-unload-guard'), so a reload or a tab
 *   close asks first even when the copy chunk never arrived;
 * - the kept fallback line (restoreCopyCore RESTORE_COPY_FALLBACK_KEPT), the
 *   full sentence the notice says when that chunk failed while kept.
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
const entry = await readFile(path.join(distDir, 'assets', entryMatch[1]), 'utf8');
const copy = await readFile(path.join(distDir, 'assets', lazyCopy[0]), 'utf8');

const failures = [];
for (const { what, pattern } of MARKERS) {
  if (!pattern.test(entry)) failures.push(`${what} is not in the entry chunk ${entryMatch[1]}`);
  if (pattern.test(copy)) failures.push(`${what} is in the lazy chunk ${lazyCopy[0]}; it must stay in the entry chunk`);
}
if (failures.length > 0) {
  throw new Error(`Kept guard check failed (GM r23, 3): ${failures.join('; ')}.`);
}
console.log(`Kept guard check passed: the kept unload guard and the kept fallback line are in ${entryMatch[1]}, not in ${lazyCopy[0]}.`);
