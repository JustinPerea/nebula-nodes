import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Design: the repo is public, so comments and test titles say "design" and carry no internal
// ids. Three kinds of id are counted per file:
//   - the studio initials as a standalone uppercase word, anywhere in the file;
//   - a round id, only inside a comment or a test title (the first string argument of
//     it/test/describe): the phrase "round N[letter]" anywhere there, or the letter r with one to
//     three digits and an optional letter when it reads as a design round (right after the
//     studio initials, "design", "review" or "PR #N", or right before "item", "answer" or a
//     question id). A bare r1 elsewhere is a domain id (a region, a radius) and is not counted;
//   - a question id (the letter Q and one to three digits), only inside the same places.
// Round and question ids are restricted to comments and titles so identifiers, SVG attributes and
// CSS values never trip the check. Existing matches are frozen in internal-ids-baseline.json; a
// file's count may fall, never rise, and a file missing from the baseline may have none.
//
// What counts as a comment:
//   TS, TSX, JS, MJS, CJS: // to end of line, and /* ... */ blocks.
//   CSS: /* ... */ blocks.
//   Python and shell: # to end of line (outside strings), and docstrings: a triple-quoted string
//   that is the first statement of a module, class or def. A triple-quoted string assigned to a
//   name, passed as an argument or returned is a value and is not a comment.
// What counts as a title: a string literal directly after it( / test( / describe( (also
// .skip/.only/.todo variants) in TS, TSX, JS, MJS.
//
// This file and its test hold the patterns and fixtures, so both are skipped by name (SELF_SKIP).
// A text scanner, not a parser: a regex literal that holds an unbalanced quote can confuse it.

export const SCAN_DIRS = ['frontend/src', 'frontend/scripts', 'frontend/tests', 'backend', 'scripts'];
export const SCAN_EXT = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs', 'css', 'py', 'sh']);
// Directories skipped anywhere in the path: dependencies and build output.
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', '__pycache__', '.git']);
// Path prefixes (repo-relative) that hold data rather than prose.
export const SKIP_PREFIXES = [
  'backend/tests/fixtures/',
  'backend/data/',
  'frontend/tests/fixtures/',
  'frontend/tests/__golden__/',
];
// Lockfiles and minified or generated bundles are never prose.
const SKIP_FILE = /(^|\/)(package-lock\.json|[^/]*\.lock|[^/]*\.min\.(js|css)|[^/]*\.snap)$/;
export const SELF_SKIP = new Set([
  'frontend/scripts/check-internal-ids.mjs',
  'frontend/tests/internalIdCheck.test.ts',
]);
export const BASELINE_REL = 'frontend/scripts/internal-ids-baseline.json';

const GM_RE = /\bGM\b/g;
const ROUND_RE = /\br\d{1,3}[a-z]?\b|\bround\s+\d{1,3}[a-z]?\b/gi;
const ROUND_BEFORE = /(?:\bGM|\bdesign|\breview|\bPR\s*#\d+)[,\s]*$/i;
const ROUND_AFTER = /^[,\s]*(?:item\b|answer\b|Q\d)/i;
const Q_RE = /\bQ\d{1,3}\b/g;
const TITLE_CALL = /\b(?:it|test|describe)(?:\.(?:skip|only|todo|concurrent))?\(\s*$/;

/** Find comment and title spans in source. Returns [{start, end, kind}] with kind comment|title. */
export function findSpans(path, text) {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  if (ext === 'py' || ext === 'sh') return pythonSpans(text, ext === 'py');
  return jsSpans(text, ext !== 'css');
}

function jsSpans(text, isScript) {
  const spans = [];
  const n = text.length;
  let i = 0;
  let prevSig = '';
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      spans.push({ start: i, end: stop, kind: 'comment' });
      i = stop;
      continue;
    }
    if (isScript && c === '/' && d === '/') {
      let stop = text.indexOf('\n', i);
      if (stop === -1) stop = n;
      spans.push({ start: i, end: stop, kind: 'comment' });
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') i++;
        else if (c !== '`' && text[i] === '\n') break;
        i++;
      }
      i++;
      if (isScript && c !== '`' && TITLE_CALL.test(text.slice(Math.max(0, start - 40), start))) {
        spans.push({ start: start + 1, end: Math.min(i - 1, n), kind: 'title' });
      } else if (isScript && c === '`' && TITLE_CALL.test(text.slice(Math.max(0, start - 40), start))) {
        spans.push({ start: start + 1, end: Math.min(i - 1, n), kind: 'title' });
      }
      prevSig = c;
      continue;
    }
    if (isScript && c === '/' && (prevSig === '' || '(,=:[!&|?{};'.includes(prevSig))) {
      // regex literal: skip to the closing slash on the same line
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      if (j < n && text[j] === '/') {
        i = j + 1;
        prevSig = ')';
        continue;
      }
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return spans;
}

function pythonSpans(text, isPython) {
  const spans = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      let stop = text.indexOf('\n', i);
      if (stop === -1) stop = n;
      spans.push({ start: i, end: stop, kind: 'comment' });
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = isPython && text.startsWith(c.repeat(3), i);
      if (triple && !isDocstringStart(text, i)) {
        // a value (assigned, passed, returned): skip it as a plain string
        const q = c.repeat(3);
        let j = i + 3;
        while (j < n && !text.startsWith(q, j)) {
          if (text[j] === '\\') j++;
          j++;
        }
        i = j + 3;
        continue;
      }
      if (triple) {
        const q = c.repeat(3);
        let j = i + 3;
        while (j < n && !text.startsWith(q, j)) {
          if (text[j] === '\\') j++;
          j++;
        }
        spans.push({ start: i, end: Math.min(j + 3, n), kind: 'comment' });
        i = j + 3;
        continue;
      }
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return spans;
}

// A triple-quoted string is a docstring when it starts its line and the code before it is
// nothing (module), or a def/class header ending in a colon.
function isDocstringStart(text, at) {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  if (!/^[ \t]*[rRbBuUfF]{0,2}$/.test(text.slice(lineStart, at))) return false;
  const prior = text
    .slice(0, lineStart)
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trimEnd())
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (prior.length === 0) return true;
  if (!prior[prior.length - 1].endsWith(':')) return false;
  for (let k = prior.length - 1, seen = 0; k >= 0 && seen < 40; k--, seen++) {
    if (/^\s*(?:async\s+def|def|class)\b/.test(prior[k])) return true;
    if (k < prior.length - 1 && prior[k].endsWith(':')) return false;
  }
  return false;
}

/** Every match in one file: [{line, text, kind: 'gm'|'round'|'question', match}]. */
export function scanSource(path, text) {
  const spans = findSpans(path, text);
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineText = (idx) => text.slice(lineStarts[idx], lineStarts[idx + 1] === undefined ? text.length : lineStarts[idx + 1] - 1).trim();
  const out = [];
  const push = (offset, kind, match) => {
    const idx = lineOf(offset);
    out.push({ line: idx + 1, text: lineText(idx), kind, match });
  };
  for (const m of text.matchAll(GM_RE)) push(m.index, 'gm', m[0]);
  for (const s of spans) {
    const body = text.slice(s.start, s.end);
    for (const m of body.matchAll(ROUND_RE)) {
      if (/^[rR]\d/.test(m[0])) {
        // A bare id counts only in a design-round context, with a lowercase r.
        if (m[0][0] !== 'r') continue;
        const before = body.slice(Math.max(0, m.index - 24), m.index);
        const after = body.slice(m.index + m[0].length, m.index + m[0].length + 16);
        if (!ROUND_BEFORE.test(before) && !ROUND_AFTER.test(after)) continue;
      }
      push(s.start + m.index, 'round', m[0]);
    }
    for (const m of body.matchAll(Q_RE)) push(s.start + m.index, 'question', m[0]);
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

export function isScanned(rel) {
  if (SELF_SKIP.has(rel)) return false;
  if (!SCAN_DIRS.some((d) => rel.startsWith(`${d}/`))) return false;
  if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) return false;
  if (rel.split('/').some((seg) => SKIP_DIR_NAMES.has(seg))) return false;
  if (SKIP_FILE.test(rel)) return false;
  return SCAN_EXT.has(rel.slice(rel.lastIndexOf('.') + 1));
}

/** Tracked files when root is a git work tree, else a directory walk. Repo-relative, '/' separated. */
export function listFiles(root) {
  let rels;
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...SCAN_DIRS], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    rels = out.split('\0').filter(Boolean);
  } catch {
    rels = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else rels.push(relative(root, full).split(sep).join('/'));
      }
    };
    for (const d of SCAN_DIRS) walk(join(root, d));
  }
  return rels.filter(isScanned).filter((rel) => existsSync(join(root, rel)));
}

/** Scan the tree. Returns {counts: {file: n}, matches: {file: [...]}, totals: {gm, round, question}}. */
export function scanTree(root) {
  const counts = {};
  const matches = {};
  const totals = { gm: 0, round: 0, question: 0 };
  for (const rel of listFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    const found = scanSource(rel, text);
    if (found.length === 0) continue;
    counts[rel] = found.length;
    matches[rel] = found;
    for (const f of found) totals[f.kind]++;
  }
  return { counts, matches, totals };
}

/** Compare counts with a baseline. Fails on a rise or an unlisted file with matches; notes a fall. */
export function compareToBaseline(counts, matches, baseline) {
  const failures = [];
  const notes = [];
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      const list = matches[file] ?? [];
      const shown = list.slice(0, 8).map((m) => `    ${file}:${m.line}  ${m.text.slice(0, 120)}`);
      failures.push({ file, count, allowed, lines: shown, more: Math.max(0, list.length - shown.length) });
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = counts[file] ?? 0;
    if (count < allowed) notes.push({ file, count, allowed });
  }
  return { failures, notes };
}

/** The lowered baseline: counts only fall, files at zero drop out, no file is added. */
export function lowerBaseline(counts, baseline) {
  const next = {};
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = Math.min(counts[file] ?? 0, allowed);
    if (count > 0) next[file] = count;
  }
  return next;
}

function sortedObject(o) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootArg = argv.indexOf('--root');
  const root = rootArg >= 0 ? resolve(argv[rootArg + 1]) : resolve(here, '..', '..');
  const baselinePath = join(root, BASELINE_REL);
  const write = argv.includes('--write-baseline');
  const { counts, matches, totals } = scanTree(root);
  const haveBaseline = existsSync(baselinePath);

  if (write) {
    if (!haveBaseline) {
      writeFileSync(baselinePath, `${JSON.stringify(sortedObject(counts), null, 2)}\n`);
      console.log(`internal-ids: created baseline with ${Object.keys(counts).length} files.`);
      return 0;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const next = lowerBaseline(counts, baseline);
    const refused = Object.keys(counts).filter((f) => (counts[f] ?? 0) > (baseline[f] ?? 0));
    writeFileSync(baselinePath, `${JSON.stringify(sortedObject(next), null, 2)}\n`);
    console.log(`internal-ids: baseline now ${Object.keys(next).length} files.`);
    if (refused.length > 0) {
      console.error(`internal-ids: ${refused.length} file(s) are above their baseline and were not raised. Write "design" instead and drop the id; run the check to see where.`);
      return 1;
    }
    return 0;
  }

  const baseline = haveBaseline ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  const { failures, notes } = compareToBaseline(counts, matches, baseline);
  if (failures.length > 0) {
    console.error('internal-ids: internal ids in a public repo. Write "design" instead and drop the id (studio initials, round ids, question ids).');
    for (const f of failures) {
      console.error(`\n  ${f.file}: ${f.count} match(es), baseline allows ${f.allowed}`);
      for (const l of f.lines) console.error(l);
      if (f.more > 0) console.error(`    ... and ${f.more} more`);
    }
    return 1;
  }
  if (notes.length > 0) {
    console.log(`internal-ids: ${notes.length} file(s) fell below their baseline (run \`node scripts/check-internal-ids.mjs --write-baseline\` to lock it in).`);
  }
  console.log(`internal-ids: ok (${Object.keys(counts).length} files, ${totals.gm} studio, ${totals.round} round, ${totals.question} question matches, all within baseline).`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
