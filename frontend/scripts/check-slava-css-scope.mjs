import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const STYLES_DIR = join(ROOT, 'src', 'styles');

const SHARED_CSS_FILES = new Set([
  'canvas.css',
  'layouts.css',
  'nodes.css',
  'panels.css',
  'skin-picker.css',
]);

const VISUAL_PROPS = new Set([
  '-webkit-backdrop-filter',
  'backdrop-filter',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-bottom',
  'border-bottom-color',
  'border-color',
  'border-left',
  'border-left-color',
  'border-right',
  'border-right-color',
  'border-top',
  'border-top-color',
  'box-shadow',
  'caret-color',
  'color',
  'fill',
  'filter',
  'outline',
  'outline-color',
  'scrollbar-color',
  'stroke',
  'text-shadow',
]);

const NEUTRAL_VALUES = [
  /^none(?:\s*!important)?$/i,
  /^0(?:\s*!important)?$/i,
  /^0px(?:\s*!important)?$/i,
  /^transparent(?:\s*!important)?$/i,
  /^inherit(?:\s*!important)?$/i,
  /^currentcolor(?:\s*!important)?$/i,
  /^unset(?:\s*!important)?$/i,
  /^initial(?:\s*!important)?$/i,
];

const SENSITIVE_SELECTOR_PATTERNS = [
  /\.agent-log(?:__|--|\b)/,
  /\.canvas-wrapper(?:__|--|\b)/,
  /\.chat(?:__|--|\b)/,
  /\.chat-panel(?:__|--|\b)/,
  /\.connection-popup(?:__|--|\b)/,
  /\.context-menu(?:__|--|\b)/,
  /\.dynamic-node(?:__|--|\b)/,
  /\.inspector(?:__|--|\b)/,
  /\.mesh-(?:modal|preview)(?:__|--|\b)/,
  /\.model-node(?:__|--|\b)/,
  /\.panel(?:__|--|\b)/,
  /\.react-flow(?:__|--|-|\b)/,
  /\.reroute-node(?:__|--|\b)/,
  /\.settings(?:__|--|\b)/,
  /\.skin-picker(?:__|--|\b)/,
  /\.toolbar(?:__|--|\b)/,
];

const SCOPED_SELECTOR_PATTERNS = [
  /body\.app-slava-restraint\b/,
  /body:not\(\.app-slava-restraint\)/,
  /body\.app-hermes\b/,
  /body\.app-slava-wayfinding\b/,
];

const files = collectCssFiles(STYLES_DIR).filter((file) => SHARED_CSS_FILES.has(file.split('/').pop()));
const violations = [];

for (const file of files) {
  const css = readFileSync(file, 'utf8');
  const lineStarts = computeLineStarts(css);
  for (const rule of parseRules(css)) {
    if (!hasSensitiveSelector(rule.selector)) continue;
    if (isScopedSelector(rule.selector)) continue;

    for (const declaration of parseDeclarations(rule.body, rule.bodyStart)) {
      if (!VISUAL_PROPS.has(declaration.prop)) continue;
      if (isNeutralValue(declaration.value)) continue;
      if (isColorlessBorderGeometry(declaration.prop, declaration.value)) continue;

      violations.push({
        file: relative(ROOT, file),
        line: lineForOffset(lineStarts, declaration.offset),
        selector: compact(rule.selector),
        prop: declaration.prop,
        value: declaration.value,
      });
    }
  }
}

if (violations.length > 0) {
  console.error('Unscoped Slava-sensitive visual CSS found.');
  console.error('Scope visual rules to body.app-slava-restraint or body:not(.app-slava-restraint); keep shared rules structural.');
  for (const violation of violations) {
    console.error(
      `  ${violation.file}:${violation.line} ${violation.selector} { ${violation.prop}: ${violation.value}; }`,
    );
  }
  process.exit(1);
}

console.log(`Slava CSS scope guard passed (${files.length} shared style files scanned).`);

function collectCssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...collectCssFiles(path));
    } else if (entry.endsWith('.css')) {
      out.push(path);
    }
  }
  return out;
}

function parseRules(css, baseOffset = 0) {
  const rules = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open === -1) break;
    const close = findMatchingBrace(css, open);
    if (close === -1) break;

    const selectorStart = findSelectorStart(css, open);
    const selector = css.slice(selectorStart, open).trim();
    const body = css.slice(open + 1, close);

    if (selector.startsWith('@')) {
      rules.push(...parseRules(body, baseOffset + open + 1));
    } else if (selector) {
      rules.push({
        selector,
        body,
        bodyStart: baseOffset + open + 1,
      });
    }

    cursor = close + 1;
  }
  return rules;
}

function findMatchingBrace(css, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

function findSelectorStart(css, openIndex) {
  const prevClose = css.lastIndexOf('}', openIndex);
  const prevSemicolon = css.lastIndexOf(';', openIndex);
  const prevBoundary = Math.max(prevClose, prevSemicolon);
  return prevBoundary + 1;
}

function parseDeclarations(body, bodyStart) {
  const declarations = [];
  const parts = body.split(';');
  let offset = 0;

  for (const part of parts) {
    const colon = part.indexOf(':');
    if (colon === -1) {
      offset += part.length + 1;
      continue;
    }

    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    const propOffset = bodyStart + offset + part.indexOf(prop);
    declarations.push({ prop, value, offset: propOffset });
    offset += part.length + 1;
  }

  return declarations;
}

function hasSensitiveSelector(selector) {
  return SENSITIVE_SELECTOR_PATTERNS.some((pattern) => pattern.test(selector));
}

function isScopedSelector(selector) {
  return SCOPED_SELECTOR_PATTERNS.some((pattern) => pattern.test(selector));
}

function isNeutralValue(value) {
  const normalized = value.trim().toLowerCase();
  return NEUTRAL_VALUES.some((pattern) => pattern.test(normalized));
}

function isColorlessBorderGeometry(prop, value) {
  if (!prop.startsWith('border')) return false;
  const normalized = value.trim().toLowerCase();
  return (
    /\b(?:solid|dashed|dotted|double)\b/.test(normalized)
    && !/(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(|var\(|currentcolor|white|black|transparent)/i.test(normalized)
  );
}

function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineForOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function compact(selector) {
  return selector.replace(/\s+/g, ' ');
}
