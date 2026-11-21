import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Design: the repo is public, so comments and test titles say "design" and carry no internal
// ids. Five kinds are counted per file:
//   - the studio initials as a standalone uppercase word, anywhere in the file;
//   - a round id, only inside a comment or a test title (the first string argument of
//     it/test/describe): the phrase "round N[letter]" anywhere there, or the letter r with one to
//     three digits and an optional letter when it reads as a design round (right after the
//     studio initials, "design", "review", "since", "per", "PR #N" or "#N", right before "item",
//     "answer" or a question id, or as the next link of a slash chain whose earlier link counts).
//     A bare r1 elsewhere is a domain id (a region, a radius) and is not counted, nor is an
//     uppercase R1;
//   - a question id (the letter Q and one to three digits), only inside the same places;
//   - a review id, only inside the same places: "Review N" in any case, or a severity id
//     (LOW-N, MED-N, MEDIUM-N, HIGH-N, NIT-N; a one-letter H-N, L-N, M-N or N-N only right after
//     a review id or another severity id, since "N-1" alone is arithmetic);
//   - the word "lane", only inside text people and agents read: a JS/TS string or template
//     literal (its literal text, never a ${} expression), JSX text, a test title, or any Python
//     string (docstrings, triple-quoted constants and f-strings included; never an f-string
//     replacement field). The TypeScript parser finds those in .ts, .tsx, .js, .jsx, .mjs and .cjs.
//     An identifier, a comment, a CSS class or a grid-area named lane is code and does not count,
//     and stylesheets are not read for it at all.
// Round, question and review ids are restricted to comments and titles so identifiers, SVG
// attributes and CSS values never trip the check. "round N" is skipped when it reads as
// arithmetic (a decimal point, "decimal places", digits) and a question id after "quarter" or
// "fiscal" is skipped. Existing matches are frozen in internal-ids-baseline.json; a file's count
// may fall, never rise, and a file missing from the baseline may have none. A moved or split file
// keeps its allowance: `--move <old> <new>` carries it over (repeat the pair to split one gone file
// into several in a single call; the baseline is written only when the check then passes, and
// `--move` cannot be combined with `--write-baseline`). When origin/main and a merge base with it
// are reachable, an entry counts as a raise only when it is above both the merge-base value and
// main's value (so a branch that is merely behind main passes), and the allowance on paths that
// neither had may not exceed what the branch freed against the merge base by removing or lowering
// paths. A shallow checkout has no merge base. There the base is HEAD's first parent when it has
// been fetched, and main otherwise. CI fetches both before lint: GitHub's merge ref sits on main as
// it stood when the ref was made, which can be older than origin/main by the time lint runs.
//
// Runs of comment lines are read as one text. A run is consecutive `//` lines (`#` lines in Python
// and shell) with only whitespace between them, each continuation line starting with its marker (a
// line with code before the marker starts a new run; a trailing `// x` after code may itself start a
// run, since a wrapped trailing comment continues on standalone lines). Each line has its marker
// stripped, a block comment has its ` * ` line prefixes stripped, and the lines are joined with one
// space, so an id wrapped across two lines ("round" / "15") counts once, on the line where it starts.
// The joined text is matched in addition to each comment on its own, never instead of it, so a rule
// that reads a line end (a review id at the end of a line) keeps working and no count falls.
//
// What counts as a comment:
//   TS, TSX, JS, MJS, CJS: // to end of line, and /* ... */ blocks.
//   CSS: /* ... */ blocks.
//   Python: # to end of line (outside strings), and docstrings: a triple-quoted string that is
//   the first statement of a module, class or def. A triple-quoted string assigned to a name,
//   passed as an argument or returned is a value and is not a comment.
//   Shell: # at line start or after whitespace or ; | & (, never after $ or {.
// What counts as a title: a string literal directly after it( / test( / describe( (also the
// .skip/.only/.todo variants and .each(...)( forms) in TS, TSX, JS, MJS. A member call such as
// RE.test('...') is not a title.
//
// This file and its tests hold the patterns and fixtures, so they are skipped by name (SELF_SKIP).
// A text scanner, not a parser. Known limits: a regex literal that holds an unbalanced quote can
// confuse it, and so can JSX text that holds // or /* or an apostrophe (it reads them as a
// comment or a string until the line or file ends). A `.each` title is followed only in the
// call-style form it.each([...])('title'); a tagged-template table, or a ")" inside a string in the
// table, is not followed.

export const SCAN_DIRS = ['frontend/src', 'frontend/scripts', 'frontend/tests', 'backend', 'scripts'];
export const SCAN_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'py', 'sh']);
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
  'backend/tests/test_agent_text_wording.py',
]);
export const BASELINE_REL = 'frontend/scripts/internal-ids-baseline.json';
export const KINDS = ['gm', 'round', 'question', 'review', 'lane'];

const GM_RE = /\bGM\b/g;
// "lane" is how the studio organises its own work, not a Nebula word; agents and people read
// "session". Counted as a whole word in any case, only inside the text people and agents read (a
// JS/TS string or template literal, JSX text, a test title, a Python string). Never in a comment,
// where "the scrollbar lane" is ordinary English, and never in code, where an identifier, a CSS
// class or a grid-area may be named lane.
const LANE_RE = /\blanes?\b/gi;
const ROUND_RE = /\br\d{1,3}[a-z]?\b|\bround\s+\d{1,3}[a-z]?\b/gi;
const ROUND_BEFORE = /(?:\b(?:design|review|since|per)|PR\s*#\d+|#\d+)[,\s]*$/i;
const ROUND_BEFORE_GM = /\bGM[,\s]*$/;
const ROUND_AFTER = /^[,\s]*(?:item\b|answer\b|Q\d)/i;
const ROUND_ARITH_AFTER = /^(?:\.\d|\s+(?:decimal|places?|digits?|dp|sig)\b)/i;
const Q_RE = /\bQ\d{1,3}\b/g;
const Q_FISCAL_BEFORE = /\b(?:quarters?|fiscal)\b/i;
const REVIEW_RE = /\breview\s+\d{1,3}\b/gi;
// "review N" counts only when what follows reads as an id: punctuation, the end of the line or
// comment, a severity id, a token like M1, "round", rN, or "of PR #N" / "on #N". "review 3 items" is prose.
const REVIEW_AFTER = /^(?:[ \t]*(?:\r?\n|\*\/|$)|[ \t]*(?:[,;:)\]\/]|\.(?!\d))|\s+(?:(?:LOW|MED|MEDIUM|HIGH|NIT)-\d|[A-Z]-\d|[A-Z]\d+\b|[Rr]ound\b|r\d|(?:of|on)\s+(?:PR\b|#\d)))/;
const SEVERITY_RE = /\b(?:LOW|MED|MEDIUM|HIGH|NIT)-\d{1,2}\b/g;
// A one-letter severity (H-1, N-2) reads as arithmetic on its own ("the last N-1 frames"), so it
// counts only right after a review id or another severity id.
const LETTER_SEVERITY_RE = /\b[HLMN]-\d{1,2}\b/g;
const LETTER_SEVERITY_BEFORE = /(?:\breview\s+\d{1,3}|\b(?:LOW|MED|MEDIUM|HIGH|NIT|[HLMN])-\d{1,2})[,;/\s]*$/i;
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'do', 'else', 'void', 'delete', 'throw', 'yield', 'await', 'new']);
// `<` and `>` are not here: `/` after `<` is a JSX closing tag. A `>` counts only as the end of `=>`;
// a doubled `+` or `-` is postfix, so the `/` after it divides.
const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^';
const CALLEE_TAIL = /(?:^|[^.\w$])(?:it|test|describe)(?:\.(?:skip|only|todo|concurrent|fails|sequential))?$/;
const EACH_TAIL = /(?:^|[^.\w$])(?:it|test|describe)(?:\.(?:skip|only|concurrent|fails|sequential))?\.each\s*$/;

/**
 * Find comment and title spans in source. Returns [{start, end, kind}] with kind comment|title.
 * In Python files the literal text of every string is also returned, as kind string.
 */
export function findSpans(path, text) {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  if (ext === 'py' || ext === 'sh') return hashSpans(text, ext === 'py');
  return jsSpans(text, ext !== 'css');
}

const require = createRequire(import.meta.url);
let tsApi;
/** The TypeScript compiler API, loaded on first use from frontend's node_modules. */
function loadTs() {
  if (!tsApi) tsApi = require('typescript');
  return tsApi;
}

const SCRIPT_KINDS = { ts: 'TS', mts: 'TS', cts: 'TS', tsx: 'TSX', js: 'JSX', jsx: 'JSX', mjs: 'JSX', cjs: 'JSX' };

/**
 * Spans of the text people and agents read in a JS/TS-family file, found with the TypeScript parser:
 * the literal text of every string, no-substitution template, template head, middle and tail (never
 * the ${} expressions), and JSX text. Import and export module paths are code, not prose, and are
 * skipped. Comments, identifiers and types never count. A file whose text has no "lane" cannot hold
 * a match, so it is not parsed.
 */
function readableSpansJs(path, text) {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  const kind = SCRIPT_KINDS[ext];
  if (!kind || !/lane/i.test(text)) return [];
  const ts = loadTs();
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind[kind]);
  const K = ts.SyntaxKind;
  const out = [];
  const visit = (node) => {
    switch (node.kind) {
      case K.StringLiteral:
        if (!((node.parent.kind === K.ImportDeclaration || node.parent.kind === K.ExportDeclaration) && node.parent.moduleSpecifier === node)) {
          out.push({ start: node.getStart(sf), end: node.getEnd(), kind: 'string' });
        }
        break;
      case K.NoSubstitutionTemplateLiteral:
      case K.TemplateHead:
      case K.TemplateMiddle:
      case K.TemplateTail:
      case K.JsxText:
        out.push({ start: node.getStart(sf), end: node.getEnd(), kind: 'string' });
        break;
      default:
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// Is the string that starts at `start` the first argument of it( / test( / describe( or an
// .each(...)( form of them? A member call (RE.test(...)) is not.
function isTitleStart(text, start) {
  let j = start - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (text[j] !== '(') return false;
  j--;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (text[j] === ')') {
    let depth = 0;
    let k = j;
    for (; k >= 0 && j - k < 20000; k--) {
      if (text[k] === ')') depth++;
      else if (text[k] === '(' && --depth === 0) break;
    }
    if (k < 0 || depth !== 0) return false;
    return EACH_TAIL.test(text.slice(Math.max(0, k - 48), k));
  }
  return CALLEE_TAIL.test(text.slice(Math.max(0, j - 47), j + 1));
}

function jsSpans(text, isScript) {
  const spans = [];
  const n = text.length;
  let i = 0;
  let prevSig = '';
  let prevWord = '';
  let prevWordDot = false; // the last word followed a "." (a property, not a keyword)
  let prevAdj = ''; // the character right before prevSig
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
      if (isScript && isTitleStart(text, start)) {
        spans.push({ start: start + 1, end: Math.min(i - 1, n), kind: 'title' });
      }
      prevSig = c;
      continue;
    }
    const doubled = (prevSig === '+' || prevSig === '-') && prevAdj === prevSig;
    const regexOk =
      prevSig === '' ||
      (REGEX_PRECEDERS.includes(prevSig) && !doubled && !(prevSig === '}' && d === '>')) || // `{x} />` closes a JSX tag
      (prevSig === '>' && prevAdj === '=') ||
      (prevSig === 'a' && !prevWordDot && REGEX_KEYWORDS.has(prevWord));
    if (isScript && c === '/' && regexOk) {
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
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j])) j++;
      prevWord = text.slice(i, j);
      prevWordDot = prevSig === '.';
      prevSig = 'a';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      prevSig = c;
      prevAdj = i > 0 ? text[i - 1] : '';
    }
    i++;
  }
  return spans;
}

const cleanLine = (l) => l.replace(/\s+#.*$/, '').trimEnd();
const isMeaningful = (l) => {
  const t = cleanLine(l).trim();
  return t !== '' && !t.startsWith('#');
};
const DEF_START = /^\s*(?:async\s+def|def|class)\b/;

// A triple-quoted string is a docstring when it starts its line and the nearest meaningful line
// before it is nothing (module), a def/class header, or the end of a multi-line signature.
// Walks back from the string's own line, so the cost does not depend on the file's length.
function isDocstringStart(lines, idx, col) {
  if (!/^[ \t]*[rRbBuUfF]{0,2}$/.test(lines[idx].slice(0, col))) return false;
  let k = idx - 1;
  while (k >= 0 && !isMeaningful(lines[k])) k--;
  if (k < 0) return true;
  const last = cleanLine(lines[k]);
  if (!last.endsWith(':') || /['"]:$/.test(last)) return false;
  if (DEF_START.test(last)) return true;
  if (!/\)\s*(?:->[^:]*)?:$/.test(last)) return false;
  for (let m = k - 1, seen = 0; m >= 0 && seen < 40; m--, seen++) {
    if (!isMeaningful(lines[m])) continue;
    const t = cleanLine(lines[m]);
    if (DEF_START.test(t)) return !t.endsWith(':');
    if (t.endsWith(':')) return false;
  }
  return false;
}

// Does the string literal whose opening quote is at `q` carry an f (or rf, fr) prefix?
function isFString(text, q) {
  let k = q - 1;
  let prefix = '';
  while (k >= 0 && /[A-Za-z]/.test(text[k]) && prefix.length < 3) prefix = text[k--] + prefix;
  return (k < 0 || !/[\w$]/.test(text[k])) && /^(?:[rR][fF]|[fF][rR]?|[fF])$/.test(prefix);
}

// Push the readable parts of a Python string whose body is [from, to): the whole body, or for an
// f-string the text outside its {replacement fields} ({{ and }} are literal braces).
function pushPyString(spans, text, start, from, to, fstring) {
  if (!fstring) {
    spans.push({ start: from, end: to, kind: 'string' });
    return;
  }
  let segStart = from;
  let depth = 0;
  for (let k = from; k < to; k++) {
    const ch = text[k];
    if (depth === 0) {
      if (ch === '{' && text[k + 1] === '{') k++;
      else if (ch === '{') {
        if (k > segStart) spans.push({ start: segStart, end: k, kind: 'string' });
        depth = 1;
      }
    } else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) segStart = k + 1;
    }
  }
  if (depth === 0 && to > segStart) spans.push({ start: segStart, end: to, kind: 'string' });
}

function hashSpans(text, isPython) {
  const spans = [];
  const n = text.length;
  const lines = isPython ? text.split('\n') : [];
  const lineStarts = [0];
  if (isPython) for (let k = 0; k < n; k++) if (text[k] === '\n') lineStarts.push(k + 1);
  const lineIndexOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '#' && (isPython || i === 0 || /[\s;|&(]/.test(text[i - 1]))) {
      let stop = text.indexOf('\n', i);
      if (stop === -1) stop = n;
      spans.push({ start: i, end: stop, kind: 'comment' });
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = isPython && text.startsWith(c.repeat(3), i);
      if (triple) {
        const q = c.repeat(3);
        let j = i + 3;
        while (j < n && !text.startsWith(q, j)) {
          if (text[j] === '\\') j++;
          j++;
        }
        const idx = lineIndexOf(i);
        if (isDocstringStart(lines, idx, i - lineStarts[idx])) {
          spans.push({ start: i, end: Math.min(j + 3, n), kind: 'comment' });
        }
        pushPyString(spans, text, i, i + 3, Math.min(j, n), isFString(text, i));
        i = j + 3;
        continue;
      }
      const start = i;
      i++;
      // Python strings end at the line; shell strings may span lines.
      while (i < n && text[i] !== c && (!isPython || text[i] !== '\n')) {
        if (text[i] === '\\' && (isPython || c === '"')) i++;
        i++;
      }
      i++;
      if (isPython) pushPyString(spans, text, start, start + 1, Math.max(start + 1, Math.min(i - 1, n)), isFString(text, start));
      continue;
    }
    i++;
  }
  return spans;
}

/** Match the id rules in one comment or title body. `offsetOf(i)` maps a body index to a file offset. */
function scanBody(body, offsetOf, push) {
  let chainEnd = -1; // end offset of the last bare round id that counted, for a slash chain
  for (const m of body.matchAll(ROUND_RE)) {
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (/^[rR]\d/.test(m[0])) {
      // A bare id counts only in a design-round context, with a lowercase r.
      if (m[0][0] !== 'r') continue;
      const before = body.slice(Math.max(0, m.index - 24), m.index);
      const chained = chainEnd === m.index - 1 && body[m.index - 1] === '/';
      if (!chained && !ROUND_BEFORE.test(before) && !ROUND_BEFORE_GM.test(before) && !ROUND_AFTER.test(after)) continue;
      chainEnd = m.index + m[0].length;
    } else if (ROUND_ARITH_AFTER.test(after)) {
      continue;
    }
    push(offsetOf(m.index), 'round', m[0]);
  }
  for (const m of body.matchAll(Q_RE)) {
    const before = body.slice(Math.max(0, m.index - 40), m.index).split('\n').pop();
    if (Q_FISCAL_BEFORE.test(before)) continue;
    push(offsetOf(m.index), 'question', m[0]);
  }
  for (const m of body.matchAll(REVIEW_RE)) {
    if (REVIEW_AFTER.test(body.slice(m.index + m[0].length))) push(offsetOf(m.index), 'review', m[0]);
  }
  for (const m of body.matchAll(SEVERITY_RE)) push(offsetOf(m.index), 'review', m[0]);
  for (const m of body.matchAll(LETTER_SEVERITY_RE)) {
    const before = body.slice(Math.max(0, m.index - 24), m.index);
    if (LETTER_SEVERITY_BEFORE.test(before)) push(offsetOf(m.index), 'review', m[0]);
  }
}

/**
 * Comment texts read as runs: [{body, map}] where map[i] is the file offset of body[i]. Only runs
 * that join at least two lines are returned (a single comment is already scanned on its own). A
 * `//` (or `#`) line joins the run above it when only whitespace and one newline lie between them;
 * a block comment is one run of its own lines with the ` * ` prefixes stripped.
 */
function commentRuns(path, text, spans) {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  const marker = ext === 'py' || ext === 'sh' ? '#' : '//';
  const runs = [];
  let lines = []; // [{text, offset}] of the open run of line comments
  const flush = () => {
    if (lines.length > 1) runs.push(joinPieces(lines));
    lines = [];
  };
  for (const s of spans) {
    if (s.kind !== 'comment') continue;
    const raw = text.slice(s.start, s.end);
    if (raw.startsWith(marker)) {
      const strip = /^(?:\/\/+|#+)[ \t]*/.exec(raw)[0].length;
      const piece = { text: raw.slice(strip).trimEnd(), offset: s.start + strip };
      const prev = lines.length > 0 ? lines[lines.length - 1] : null;
      const gap = prev ? text.slice(prev.end, s.start) : '';
      if (prev && /^\r?\n[ \t]*$/.test(gap)) lines.push({ ...piece, end: s.end });
      else {
        flush();
        lines = [{ ...piece, end: s.end }];
      }
      continue;
    }
    flush();
    if (raw.startsWith('/*') && raw.includes('\n')) {
      const pieces = [];
      let at = 0;
      for (const line of raw.split('\n')) {
        const lead = /^[ \t]*(?:\/\*+|\*+(?!\/))?[ \t]*/.exec(line)[0].length;
        const body = line.slice(lead).replace(/[ \t]*\*+\/[ \t]*$/, '').trimEnd();
        if (body !== '') pieces.push({ text: body, offset: s.start + at + lead });
        at += line.length + 1;
      }
      if (pieces.length > 1) runs.push(joinPieces(pieces));
    }
  }
  flush();
  return runs;
}

/** Join pieces with one space; the map sends each character, and each joining space, to its file offset. */
function joinPieces(pieces) {
  let body = '';
  const map = [];
  pieces.forEach((p, k) => {
    if (k > 0) {
      body += ' ';
      map.push(p.offset);
    }
    for (let c = 0; c < p.text.length; c++) {
      body += p.text[c];
      map.push(p.offset + c);
    }
  });
  map.push(map.length > 0 ? map[map.length - 1] + 1 : 0);
  return { body, map };
}

/** Every match in one file: [{line, text, kind: 'gm'|'round'|'question'|'review'|'lane', match}]. */
export function scanSource(path, text) {
  const allSpans = findSpans(path, text);
  const spans = allSpans.filter((s) => s.kind !== 'string');
  // Text people and agents read: every Python string, and the strings and JSX text the TypeScript
  // parser finds. Stylesheets and shell scripts hold none.
  const ext = path.slice(path.lastIndexOf('.') + 1);
  const readable = ext === 'py' ? allSpans.filter((s) => s.kind === 'string') : readableSpansJs(path, text);
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
  for (const m of text.matchAll(LANE_RE)) {
    if (!readable.some((s) => m.index >= s.start && m.index < s.end)) continue;
    push(m.index, 'lane', m[0]);
  }
  const seen = new Set();
  const add = (offset, kind, match) => {
    const key = `${kind}:${offset}`;
    if (seen.has(key)) return;
    seen.add(key);
    push(offset, kind, match);
  };
  for (const s of spans) scanBody(text.slice(s.start, s.end), (i) => s.start + i, add);
  for (const run of commentRuns(path, text, spans)) scanBody(run.body, (i) => run.map[i], add);
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

/** Tracked and untracked (not ignored) files when root is a git work tree, else a directory walk. */
export function listFiles(root) {
  let rels;
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCAN_DIRS], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    rels = [...new Set(out.split('\0').filter(Boolean))];
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

/** Scan the tree. Returns {counts: {file: n}, matches: {file: [...]}, totals: {kind: n}}. */
export function scanTree(root) {
  const counts = {};
  const matches = {};
  const totals = Object.fromEntries(KINDS.map((k) => [k, 0]));
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

/**
 * Compare counts with a baseline. Fails on a rise or an unlisted file with matches; notes a fall.
 * A failing new path gets a move hint when baseline paths that vanished or fell free enough
 * allowance in the same run.
 */
export function compareToBaseline(counts, matches, baseline) {
  const failures = [];
  const notes = [];
  const freed = {};
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = counts[file] ?? 0;
    if (count < allowed) {
      notes.push({ file, count, allowed });
      freed[file] = allowed - count;
    }
  }
  const newPaths = Object.keys(counts)
    .filter((f) => !(f in baseline) && counts[f] > 0)
    .sort((a, b) => counts[b] - counts[a]);
  const hints = {};
  for (const file of newPaths) {
    const source = Object.keys(freed)
      .filter((f) => !(f in counts) && freed[f] >= counts[file])
      .sort((a, b) => freed[b] - freed[a])[0];
    if (source) {
      freed[source] -= counts[file];
      hints[file] = `${file} looks like a move of ${source} (${baseline[source]} allowed): run with --move ${source} ${file}, or drop the ids`;
    }
  }
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      const list = matches[file] ?? [];
      const shown = list.slice(0, 8).map((m) => `    ${file}:${m.line}  ${m.text.slice(0, 120)}`);
      failures.push({ file, count, allowed, lines: shown, more: Math.max(0, list.length - shown.length), hint: hints[file] });
    }
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

/**
 * Move an allowance from one path to another (a rename or a split). The new path gets what the
 * old one held, capped at the new file's real count; the old entry keeps what it still needs, or
 * the whole unspent remainder when the old file is gone (nothing, for a rename). Throws when the old path is not in the baseline.
 */
export function moveAllowance(baseline, counts, oldPath, newPath) {
  if (!(oldPath in baseline)) throw new Error(`${oldPath} is not in the baseline`);
  const next = { ...baseline };
  const room = Math.max(0, (counts[newPath] ?? 0) - (baseline[newPath] ?? 0));
  const moved = Math.min(baseline[oldPath], room);
  if (moved + (baseline[newPath] ?? 0) > 0) next[newPath] = (baseline[newPath] ?? 0) + moved;
  // A gone old path keeps what is left so the next --move can spend it; a later --write-baseline
  // drops the unused part. A file still present keeps only what it still needs.
  const remainder = oldPath in counts ? Math.min(baseline[oldPath] - moved, counts[oldPath]) : baseline[oldPath] - moved;
  if (remainder > 0) next[oldPath] = remainder;
  else delete next[oldPath];
  return next;
}

/**
 * Compare the baseline with main's and with the merge base's. An entry is a raise only when it is
 * above both (a missing path counts as 0), so a branch that is merely behind main passes. Paths
 * that neither had may hold no more allowance than the branch freed against the merge base, so a
 * move passes and a raise does not. Without a merge-base baseline, main's stands in for it.
 * Returns a list of messages, empty when fine.
 */
export function compareWithMain(baseline, mainBaseline, baseBaseline = mainBaseline) {
  const problems = [];
  let added = 0;
  let freed = 0;
  for (const [file, allowed] of Object.entries(baseline)) {
    const inMain = file in mainBaseline;
    const inBase = file in baseBaseline;
    if (!inMain && !inBase) {
      added += allowed;
      continue;
    }
    const ceiling = Math.max(mainBaseline[file] ?? 0, baseBaseline[file] ?? 0);
    if (allowed > ceiling) {
      const fromBase = (baseBaseline[file] ?? 0) > (mainBaseline[file] ?? 0);
      const note = fromBase ? `the merge base's ${baseBaseline[file]}` : `main's ${mainBaseline[file]}`;
      problems.push(`${file}: baseline ${allowed} is above ${note}`);
    }
  }
  for (const [file, was] of Object.entries(baseBaseline)) {
    if (!(file in baseline)) freed += was;
    else if (baseline[file] < was) freed += was - baseline[file];
  }
  if (added > freed) problems.push(`the baseline allows ${added} matches on new paths but removed or lowered paths freed only ${freed}`);
  return problems;
}

/**
 * main's baseline and the merge base's, as {main, base}; null when origin/main, main's file or the
 * merge base's file is missing (first run). With no merge base (a shallow checkout), the base is
 * HEAD's first parent when its file can be read, and main otherwise.
 */
export function readMainBaselines(root) {
  const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 };
  const show = (rev) => JSON.parse(execFileSync('git', ['show', `${rev}:${BASELINE_REL}`], opts));
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], opts);
    let mergeBase = '';
    try {
      mergeBase = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], opts).trim();
    } catch {
      mergeBase = '';
    }
    const main = show('origin/main');
    if (mergeBase) return { main, base: show(mergeBase) };
    // CI checks out the pull request merged onto main at depth 1. The merge ref was made on main as
    // it stood then (HEAD's first parent), and origin/main may have moved since, so comparing with
    // main alone would count every lowering merged in between as this branch's raise.
    let base = main;
    const parent = firstParent(opts);
    if (parent) {
      try {
        base = show(parent);
      } catch {
        base = main;
      }
    }
    return { main, base };
  } catch {
    return null;
  }
}

/** HEAD's first parent as recorded in the commit, which a shallow checkout still knows; '' when none. */
function firstParent(opts) {
  try {
    const header = execFileSync('git', ['cat-file', 'commit', 'HEAD'], opts).split('\n\n')[0];
    return /^parent ([0-9a-f]+)$/m.exec(header)?.[1] ?? '';
  } catch {
    return '';
  }
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
  const moves = [];
  for (let k = 0; k < argv.length; k++) if (argv[k] === '--move') moves.push([argv[k + 1], argv[k + 2]]);
  if (write && moves.length > 0) {
    console.error('internal-ids: --write-baseline and --move cannot be combined. Run --move first (it writes the baseline once the check passes), then --write-baseline to lock in falls.');
    return 1;
  }
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

  const stored = haveBaseline ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  let baseline = stored;
  for (const [oldPath, newPath] of moves) {
    if (!oldPath || !newPath) {
      console.error('internal-ids: --move needs an old path and a new path (repo-relative).');
      return 1;
    }
    try {
      baseline = moveAllowance(baseline, counts, oldPath, newPath);
    } catch (e) {
      console.error(`internal-ids: ${e.message}.`);
      return 1;
    }
  }
  // Once every pair is applied, a gone old path has nothing left to move: drop its leftover so a
  // recreated file at that path starts from zero.
  for (const [oldPath] of moves) if (!(oldPath in counts)) delete baseline[oldPath];

  const { failures, notes } = compareToBaseline(counts, matches, baseline);
  let code = 0;
  if (failures.length > 0) {
    code = 1;
    console.error('internal-ids: internal ids in a public repo. Write "design" instead and drop the id (studio initials, round ids, question ids, review ids, the word lane inside a string, JSX text, a test title or a Python string; an identifier, a CSS class or a grid-area named lane is fine).');
    for (const f of failures) {
      console.error(`\n  ${f.file}: ${f.count} match(es), baseline allows ${f.allowed}`);
      for (const l of f.lines) console.error(l);
      if (f.more > 0) console.error(`    ... and ${f.more} more`);
      if (f.hint) console.error(`  hint: ${f.hint}`);
    }
  } else {
    const found = readMainBaselines(root);
    if (found) {
      const problems = compareWithMain(baseline, found.main, found.base);
      if (problems.length > 0) {
        code = 1;
        console.error('internal-ids: the baseline raises allowance against origin/main. Lower counts or move an entry with --move; do not raise one.');
        for (const p of problems) console.error(`  ${p}`);
      }
    }
  }
  if (moves.length > 0) {
    const text = `${JSON.stringify(sortedObject(baseline), null, 2)}\n`;
    if (code === 0) {
      writeFileSync(baselinePath, text);
      console.log(`internal-ids: moved ${moves.map(([o, n]) => `${o} -> ${n}`).join(', ')}.`);
    } else {
      const changed = Object.keys({ ...stored, ...baseline }).filter((f) => stored[f] !== baseline[f]);
      console.error(`internal-ids: the check fails after the move, so the baseline was not written. It would have changed: ${changed.map((f) => `${f} ${stored[f] ?? 'absent'} -> ${baseline[f] ?? 'removed'}`).join('; ') || 'nothing'}. Chain every pair in one call (--move a b --move a c) or fix the failures first.`);
    }
  }
  if (code !== 0) return code;
  if (notes.length > 0) {
    console.log(`internal-ids: ${notes.length} file(s) fell below their baseline (run \`npm run check:internal-ids -- --write-baseline\` from frontend/ to lock it in).`);
  }
  console.log(`internal-ids: ok (${Object.keys(counts).length} files, ${totals.gm} studio, ${totals.round} round, ${totals.question} question, ${totals.review} review, ${totals.lane} lane matches, all within baseline).`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
