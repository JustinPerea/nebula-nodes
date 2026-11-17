// The copy lint's engine: which strings a person reads, what rules they break, and the baseline.
// check-copy.mjs is the command; tests/copyLint.test.ts exercises this module. The rule names,
// the allowlists and the source lists live in ../scripts/copy-lint-rules.json, shared with the
// backend's backend/tests/test_copy_lint.py, and both read the same case file
// (scripts/copy-lint-cases.json) so the two implementations of each rule cannot drift.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(FRONTEND, '..');
export const RULES_PATH = path.join(REPO, 'scripts', 'copy-lint-rules.json');
export const BASELINE_PATH = path.join(FRONTEND, 'scripts', 'copy-lint-baseline.json');

export function loadRules() {
  return JSON.parse(readFileSync(RULES_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// Names: the proper names a Title Case check lets through. The explicit list is in the rules
// file; the catalogue adds every model and provider name the app already knows.

/** Display names and brand words from the node catalogue and the provider list. */
export function catalogueNames(rules, repo = REPO) {
  const phrases = new Set();
  const words = new Set();
  const firstWords = new Map();
  const clean = (name) => name.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
  const addPhrase = (name) => {
    const c = clean(name);
    if (c.includes(' ')) phrases.add(c);
    return c;
  };
  // A node's first word is a brand when two nodes share it or it has a hump or a digit
  // (ElevenLabs, MiniMax, Hunyuan3D); a lone "Style" or "Save" is just a word.
  const countFirst = (name) => {
    const c = addPhrase(name);
    if (c) firstWords.set(c.split(/\s+/)[0], (firstWords.get(c.split(/\s+/)[0]) ?? 0) + 1);
  };
  const defsFile = path.join(repo, 'backend', rules.backend.catalogueFile);
  if (existsSync(defsFile)) {
    const defs = JSON.parse(readFileSync(defsFile, 'utf8'));
    for (const def of Object.values(defs)) {
      if (def.apiProvider !== 'utility' && typeof def.displayName === 'string') countFirst(def.displayName);
      // The options of a model picker are model names ("GPT Image 2.5 Sunburst").
      for (const param of def.params ?? []) {
        if (param.key !== 'model' && !/_model$/.test(param.key)) continue;
        for (const option of param.options ?? []) if (typeof option.label === 'string') addPhrase(option.label);
      }
    }
  }
  for (const [word, count] of firstWords) if (count >= 2 || /[A-Z].*[A-Z]|\d/.test(word)) words.add(word);
  // The provider list: every label part and brand word is a name.
  for (const rel of rules.frontend.catalogueFiles) {
    const file = path.join(repo, 'frontend', rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const name = (n) => {
      const c = addPhrase(n);
      if (c) words.add(c.split(/\s+/)[0]);
    };
    for (const m of text.matchAll(/\blabel: '([^']+)'/g)) for (const part of m[1].split('\u00b7')) name(part.trim());
    for (const m of text.matchAll(/\bbrand: \[([^\]]*)\]/g)) for (const b of m[1].matchAll(/'([^']+)'/g)) name(b[1]);
  }
  return { phrases, words };
}

export function buildContext(rules, repo = REPO) {
  const names = catalogueNames(rules, repo);
  const proper = new Set();
  for (const name of [...rules.properNames, ...rules.initialisms, ...rules.keyNames, ...rules.modelWords, ...rules.calendarWords]) {
    // A name of several words is stripped whole; only a one-word name lets its word through anywhere.
    if (/[\s-]/.test(name)) names.phrases.add(name);
    else proper.add(name.toLowerCase());
  }
  for (const word of names.words) proper.add(word.toLowerCase());
  // A phrase is stripped longest first, so "GPT Image 2.5" goes before "GPT Image".
  const phrases = [...names.phrases].sort((a, b) => b.length - a.length);
  const retry = new RegExp(rules.retryPattern);
  const units = new Set(rules.units);
  return { rules, proper, phrases, retry, units };
}

// ---------------------------------------------------------------------------------------------
// Rules. `check(text, kind, ctx)` returns the names of the rules the string breaks, in order.
// kind is 'label' for a param or field label (the raw-key rule reads those) and 'text' otherwise.

const URL_RE = /https?:\/\/\S+|\b(?:localhost|127\.0\.0\.1)(?::\d+)?\S*/g;
const CODE_RE = /`[^`]*`/g;
const CURLY_SPAN_RE = /“[^”]*”/g;
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const RATIO_RE = /\b\d+(?::\d+)+\b/g;
const WORD_RE = /[A-Za-z]/;

export function isSentence(text, rules) {
  const t = text.trim();
  if (!/\s/.test(t)) return false;
  return rules.sentence.endings.includes(t.slice(-1)) || t.length > rules.sentence.minLength;
}

function stripUnitParens(text, units) {
  return text.replace(/\(([^()\s]{1,5})\)/g, (all, unit) => (units.has(unit) ? '' : all));
}

function titleCaseBreaks(text, ctx) {
  if (/^e\.g\./i.test(text)) return false;
  let rest = text;
  for (const phrase of ctx.phrases) rest = rest.split(phrase).join(' ');
  rest = rest.replace(CURLY_SPAN_RE, ' ').replace(CODE_RE, ' ').replace(URL_RE, ' ');
  let pending = true;
  let letterWords = 0;
  let hit = false;
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const endsSentence = /[.?!:]$/.test(token);
    if (!/[A-Za-z]/.test(token) || /[/~]/.test(token)) {
      if (endsSentence) pending = true;
      continue;
    }
    letterWords += 1;
    if (!pending) {
      const bare = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      for (const part of bare.split(/[-\u2011]/)) {
        if (/^[A-Z][a-z]+$/.test(part) && !ctx.proper.has(part.toLowerCase())) hit = true;
      }
    }
    pending = endsSentence;
  }
  return letterWords >= 2 && hit;
}

function rawKey(text, ctx) {
  const t = text.trim();
  if (/\s/.test(t) || t.length < 3) return false;
  if (ctx.proper.has(t.toLowerCase())) return false;
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(t)) return true; // camelCase
  if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/.test(t)) return true; // PascalCase, two or more humps
  if (/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(t)) return true; // snake_case
  return false;
}

/** Selectors, JSON samples and other code that sits in a copy file but isn't read as words. */
function codeLike(t) {
  return /^[[{]/.test(t) || /^[:.#][\w-]/.test(t) || /\[(?:aria|data|role|hidden|inert)[-\w]*[\]=]|:not\(|:scope|=>/.test(t);
}

/** "sk-...", "AIza...": the shape of a key, not a sentence cut short. */
function keyShape(t) {
  const m = /^(\S+?)\.\.\.$/.exec(t);
  return !!m && /[_\-\d]|[a-z][A-Z]|[A-Z]{2}[a-z]/.test(m[1]);
}

export function check(text, kind, ctx) {
  const hits = [];
  const { rules } = ctx;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || !WORD_RE.test(t) || codeLike(t)) return hits;
  const noCode = t.replace(CODE_RE, ' ');
  const noUrl = noCode.replace(URL_RE, ' ');
  if (/["']/.test(noUrl)) hits.push('straight-quote');
  if (/\.\.\./.test(noUrl) && !keyShape(t)) hits.push('three-dots');
  if (/—/.test(noCode)) hits.push('em-dash');
  const sentence = isSentence(t, rules);
  if (sentence) {
    const plain = stripUnitParens(
      noUrl.replace(CURLY_SPAN_RE, ' ').replace(TIME_RE, ' ').replace(RATIO_RE, ' '),
      ctx.units,
    );
    if (/[;()]|:(?=\s|$)/.test(plain)) hits.push('sentence-punctuation');
  } else if (titleCaseBreaks(noCode, ctx)) {
    hits.push('title-case');
  }
  if (kind === 'label' && rawKey(t, ctx)) hits.push('raw-key-label');
  if (ctx.retry.test(t)) hits.push('retry-button');
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Extraction from TypeScript source.

const MARKER_RE = /copy-lint-ignore(-start|-end)?\b[:\s-]*(.*)$/;

/** Marker comments: {lines: Set of exempt line numbers, markers: [{line, reason, ok}]}. */
export function readMarkers(source) {
  const lines = source.split('\n');
  const exempt = new Set();
  const markers = [];
  let blockFrom = null;
  lines.forEach((line, i) => {
    const m = MARKER_RE.exec(line);
    if (!m || !/(\/\/|\/\*|\{\/\*)/.test(line.slice(0, m.index + 2))) return;
    const n = i + 1;
    const kind = m[1] || '';
    const reason = m[2].replace(/\*\/\}?\s*$/, '').replace(/-->\s*$/, '').trim();
    if (kind === '-end') {
      if (blockFrom !== null) for (let k = blockFrom; k <= n; k += 1) exempt.add(k);
      blockFrom = null;
      markers.push({ line: n, reason: 'end', ok: true, block: true });
      return;
    }
    markers.push({ line: n, reason, ok: reason.length >= 3, block: kind === '-start' });
    if (kind === '-start') {
      blockFrom = n;
      return;
    }
    exempt.add(n);
    // A marker alone on its line exempts the line below it; one after code exempts only its own line.
    if (/^\s*(\/\/|\/\*|\{\/\*)/.test(line)) exempt.add(n + 1);
  });
  return { exempt, markers };
}

const SKIP_CALLEES = new Set([
  'test', 'match', 'matchAll', 'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'split', 'replace',
  'replaceAll', 'localeCompare', 'querySelector', 'querySelectorAll', 'closest', 'getItem', 'setItem', 'removeItem',
  'addEventListener', 'removeEventListener', 'getAttribute', 'setAttribute', 'has', 'get', 'set', 'add', 'delete',
  'require', 'import', 'RegExp', 'log', 'warn', 'error', 'info', 'debug', 'Error', 'TypeError', 'RangeError', 'fetch',
  'join', 'padStart', 'padEnd', 'repeat', 'trim', 'toLowerCase', 'toUpperCase',
]);

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}

function inSkippedContext(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n) || ts.isThrowStatement(n)) return true;
    if (ts.isCaseClause(n) || ts.isLiteralTypeNode(n)) return true;
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && SKIP_CALLEES.has(calleeName(n))) return true;
    if (ts.isBinaryExpression(n) && [
      ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword,
    ].includes(n.operatorToken.kind)) return true;
    if (ts.isElementAccessExpression(n) && n.argumentExpression === node) return true;
    if (ts.isJsxAttribute(n) || ts.isFunctionLike(n) || ts.isSourceFile(n) || ts.isBlock(n)) return false;
  }
  return false;
}

/** The text of a string, template, concatenation or choice; `{}` stands for a value. */
export function textsOf(expr) {
  const out = [];
  const walk = (e) => {
    if (!e) return;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push({ text: e.text, node: e });
    else if (ts.isTemplateExpression(e)) {
      out.push({ text: e.head.text + e.templateSpans.map((s) => `{}${s.literal.text}`).join(''), node: e });
    } else if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) walk(e.expression);
    else if (ts.isConditionalExpression(e)) {
      walk(e.whenTrue);
      walk(e.whenFalse);
    } else if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        const joined = concat(e);
        if (joined !== null) out.push({ text: joined, node: e });
      } else if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(op)) {
        walk(e.left);
        walk(e.right);
      } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) walk(e.right);
    } else if (ts.isArrowFunction(e) && !ts.isBlock(e.body)) walk(e.body);
    else if (ts.isArrayLiteralExpression(e)) e.elements.forEach(walk);
  };
  const concat = (e) => {
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = concat(e.left);
      const b = concat(e.right);
      return a === null && b === null ? null : (a ?? '{}') + (b ?? '{}');
    }
    if (ts.isParenthesizedExpression(e)) return concat(e.expression);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => `{}${s.literal.text}`).join('');
    return null;
  };
  walk(expr);
  return out;
}

function propName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return '';
}

const ENTITIES = {
  apos: "'", quot: '"', nbsp: ' ', amp: '&', lt: '<', gt: '>', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c',
  rdquo: '\u201d', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7', times: '\u00d7',
  rarr: '\u2192', larr: '\u2190',
};
/** JSX text and attribute strings with HTML entities read as the characters they draw. */
export function decodeEntities(raw) {
  return raw.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[name] ?? all;
  });
}
function jsxClean(raw) {
  return decodeEntities(raw).replace(/\s+/g, ' ').trim();
}

const PROSE_RE = /\s/;

/** Every person-facing string in one file: [{text, kind, line, source}]. */
export function extractStrings(source, relPath, rules) {
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, relPath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const props = new Set(rules.frontend.propertyNames);
  const labelProps = new Set(rules.frontend.labelPropertyNames);
  const attrs = new Set(rules.frontend.jsxAttributes);
  const labelAttrs = new Set(rules.frontend.labelJsxAttributes);
  const isCopyModule = rules.frontend.copyModules.includes(relPath);
  const found = [];
  const seen = new Set();
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const push = (item, kind, source2) => {
    if (seen.has(item.node.pos)) return;
    seen.add(item.node.pos);
    // A bare placeholder or key, a number or a symbol is not copy.
    if (!WORD_RE.test(item.text)) return;
    found.push({ text: item.text.replace(/\s+/g, ' ').trim(), kind, line: lineOf(item.node), source: source2 });
  };
  const mark = (e) => {
    // Every literal inside e is accounted for, so the generic copy-module pass skips it.
    const visit = (n) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) seen.add(n.pos);
      ts.forEachChild(n, visit);
    };
    visit(e);
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = jsxClean(node.getText(sf));
      if (text && WORD_RE.test(text)) {
        const key = node.pos;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ text, kind: 'text', line: sf.getLineAndCharacterOfPosition(node.getStart(sf) + node.getText(sf).search(/\S/)).line + 1, source: 'jsx-text' });
        }
      }
    } else if (ts.isJsxAttribute(node) && node.initializer && attrs.has(node.name.text)) {
      const kind = labelAttrs.has(node.name.text) ? 'label' : 'text';
      const init = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      for (const item of textsOf(init)) push({ ...item, text: ts.isStringLiteral(node.initializer) ? decodeEntities(item.text) : item.text }, kind, `jsx-attr:${node.name.text}`);
      mark(node.initializer);
    } else if (ts.isPropertyAssignment(node) && props.has(propName(node.name))) {
      const name = propName(node.name);
      for (const item of textsOf(node.initializer)) push(item, labelProps.has(name) ? 'label' : 'text', `property:${name}`);
      mark(node.initializer);
    } else if (isCopyModule && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))) {
      const parentIsKey = node.parent && (ts.isPropertyAssignment(node.parent) && node.parent.name === node);
      if (!seen.has(node.pos) && !parentIsKey && !inSkippedContext(node)) {
        const item = textsOf(node)[0];
        const clean = item ? item.text.replace(/\s+/g, ' ').trim() : '';
        // In a copy module only prose counts: two words or more, or a bare Retry label.
        if (item && (PROSE_RE.test(clean) || /^Retry/.test(clean))) push(item, 'text', 'copy-module');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// ---------------------------------------------------------------------------------------------
// The scan.

export function sourceFiles(rules, frontend = FRONTEND) {
  const out = [];
  const skipParts = rules.frontend.skipPathParts;
  const skipSuffix = rules.frontend.skipSuffixes;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const rel = path.relative(frontend, full).split(path.sep).join('/');
      if (skipSuffix.some((s) => rel.endsWith(s))) continue;
      if (skipParts.some((p) => `/${rel}`.includes(p))) continue;
      if (rules.frontend.agentOnlyFiles.includes(rel)) continue;
      out.push(rel);
    }
  };
  for (const root of rules.frontend.roots) walk(path.join(frontend, root));
  return out.sort();
}

/** [{file, line, rule, text}] for every string that breaks a rule, markers applied; plus the markers read. */
export function scan({ frontend = FRONTEND, repo = REPO, rules = loadRules(), ctx = buildContext(rules, repo) } = {}) {
  const violations = [];
  const markerReport = [];
  for (const rel of sourceFiles(rules, frontend)) {
    const source = readFileSync(path.join(frontend, rel), 'utf8');
    const { exempt, markers } = readMarkers(source);
    for (const m of markers) if (!m.block || m.reason !== 'end') markerReport.push({ file: rel, ...m });
    for (const s of extractStrings(source, rel, rules)) {
      if (exempt.has(s.line)) continue;
      for (const rule of check(s.text, s.kind, ctx)) violations.push({ file: `frontend/${rel}`, line: s.line, rule, text: s.text });
    }
  }
  return { violations, markers: markerReport };
}

// ---------------------------------------------------------------------------------------------
// The baseline: violations that exist today. It only shrinks.

export function familyOf(rule, file) {
  const area = /nodeDefinitions|sampleGraph|constants\//.test(file) ? '-node-definitions' : '';
  const base = {
    'straight-quote': 'straight-quotes', 'three-dots': 'three-dots', 'em-dash': 'em-dashes',
    'sentence-punctuation': 'sentence-punctuation', 'title-case': 'title-case-labels',
    'raw-key-label': 'raw-key-labels', 'retry-button': 'retry-buttons',
  }[rule] ?? rule;
  return base + area;
}

const keyOf = (e) => `${e.file}\u0000${e.rule}\u0000${e.text}`;

export function tally(violations) {
  const map = new Map();
  for (const v of violations) {
    const k = keyOf(v);
    const cur = map.get(k);
    if (cur) cur.count += 1;
    else map.set(k, { file: v.file, rule: v.rule, text: v.text, count: 1, line: v.line, lines: [v.line] });
    if (cur) cur.lines.push(v.line);
  }
  return map;
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.text.localeCompare(b.text));
}

export function readBaseline(file = BASELINE_PATH) {
  if (!existsSync(file)) return { entries: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeBaselineFile(entries, file = BASELINE_PATH) {
  const rows = sortEntries(entries).map((e) => {
    const row = { family: e.family, file: e.file, rule: e.rule, text: e.text };
    if (e.count > 1) row.count = e.count;
    return row;
  });
  writeFileSync(file, `${JSON.stringify({ entries: rows }, null, 2)}\n`);
}

/** Compare today's violations with the baseline: new ones, and entries that no longer match. */
export function compare(violations, baseline) {
  const today = tally(violations);
  const fresh = [];
  const stale = [];
  const base = new Map(baseline.entries.map((e) => [keyOf(e), e]));
  for (const [k, t] of today) {
    const allowed = base.get(k)?.count ?? (base.has(k) ? 1 : 0);
    if (t.count > allowed) fresh.push({ ...t, extra: t.count - allowed });
  }
  for (const [k, e] of base) {
    const have = today.get(k)?.count ?? 0;
    const allowed = e.count ?? 1;
    if (have < allowed) stale.push({ ...e, have });
  }
  return { fresh, stale, today };
}

/** The baseline after `--write-baseline`: entries the code no longer breaks are dropped, counts that fell are lowered, nothing is added or raised. */
export function shrink(violations, baseline) {
  const today = tally(violations);
  const kept = [];
  for (const e of baseline.entries) {
    const have = today.get(keyOf(e))?.count ?? 0;
    const count = Math.min(e.count ?? 1, have);
    if (count > 0) kept.push({ ...e, count });
  }
  return kept;
}

/** A first baseline from today's violations. Refuses when a baseline with entries exists. */
export function seed(violations, baseline) {
  if (baseline.entries.length) throw new Error('A baseline already exists. Adding an entry is a hand edit; --write-baseline only removes.');
  return [...tally(violations).values()].map((t) => ({ ...t, family: familyOf(t.rule, t.file) }));
}

export function wantsLine(rule, rules = loadRules()) {
  return rules.rules[rule];
}

export function formatFailure(item, rules = loadRules()) {
  return `${item.file}:${item.line} [${item.rule}] ${JSON.stringify(item.text)}\n    ${wantsLine(item.rule, rules)}`;
}
