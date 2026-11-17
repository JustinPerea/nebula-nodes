#!/usr/bin/env node
// check-copy: fail when a string a person reads breaks the copy rules, apart from the violations
// listed in scripts/copy-lint-baseline.json (which may only shrink). Run from frontend/:
//   npm run check:copy                    check
//   npm run check:copy -- --write-baseline  drop baseline entries the code no longer breaks (never adds)
//   npm run check:copy -- --seed-baseline   write the first baseline (refuses when one exists)
import {
  BASELINE_PATH, compare, formatFailure, loadRules, readBaseline, scan, seed, shrink, writeBaselineFile,
} from './copy-lint-core.mjs';

const args = new Set(process.argv.slice(2));
const rules = loadRules();
const { violations, markers } = scan({ rules });
const baseline = readBaseline();

const badMarkers = markers.filter((m) => !m.ok);
if (badMarkers.length) {
  for (const m of badMarkers) console.error(`${m.file}:${m.line} copy-lint-ignore needs a reason after it.`);
  process.exit(1);
}

if (args.has('--seed-baseline')) {
  writeBaselineFile(seed(violations, baseline));
  console.log(`Wrote ${BASELINE_PATH}`);
  process.exit(0);
}

if (args.has('--write-baseline')) {
  const kept = shrink(violations, baseline);
  writeBaselineFile(kept);
  console.log(`Baseline now has ${kept.length} entries (was ${baseline.entries.length}).`);
  process.exit(0);
}

const { fresh, stale } = compare(violations, baseline);
if (fresh.length) {
  console.error(`check:copy found ${fresh.reduce((n, f) => n + f.extra, 0)} new copy violation(s):`);
  for (const f of fresh) console.error(`  ${formatFailure({ ...f, line: f.lines[f.lines.length - 1] }, rules)}`);
}
if (stale.length) {
  console.error(`check:copy found ${stale.length} baseline entr${stale.length === 1 ? 'y' : 'ies'} that no longer match anything (the fix landed; delete the entry or lower its count, or run npm run check:copy -- --write-baseline):`);
  for (const s of stale) console.error(`  ${s.file} [${s.rule}] ${JSON.stringify(s.text)} (baseline ${s.count ?? 1}, now ${s.have})`);
}
if (fresh.length || stale.length) process.exit(1);
console.log(`check:copy ok: ${violations.length} known violation(s) in the baseline (${baseline.entries.length} entries), ${markers.length} marker(s).`);
