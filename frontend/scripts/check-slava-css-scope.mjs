import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  collectCssFiles,
  compact,
  computeLineStarts,
  isNeutralValue,
  lineForOffset,
  parseDeclarations,
  parseRules,
} from './lib/css-scan.mjs';

const ROOT = process.cwd();
const STYLES_DIR = join(ROOT, 'src', 'styles');

const SHARED_CSS_FILES = new Set([
  'canvas.css',
  'layouts.css',
  'nodes.css',
  'panels.css',
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
  /\.panel-launcher(?:__|--|\b)/,
  /\.panel(?:__|--|\b)/,
  /\.react-flow(?:__|--|-|\b)/,
  /\.reroute-node(?:__|--|\b)/,
  /\.settings(?:__|--|\b)/,
  /\.toolbar(?:__|--|\b)/,
];

const SCOPED_SELECTOR_PATTERNS = [
  /body\.app-slava-restraint\b/,
  /body:not\(\.app-slava-restraint\)/,
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

function hasSensitiveSelector(selector) {
  return SENSITIVE_SELECTOR_PATTERNS.some((pattern) => pattern.test(selector));
}

function isScopedSelector(selector) {
  return SCOPED_SELECTOR_PATTERNS.some((pattern) => pattern.test(selector));
}

function isColorlessBorderGeometry(prop, value) {
  if (!prop.startsWith('border')) return false;
  const normalized = value.trim().toLowerCase();
  return (
    /\b(?:solid|dashed|dotted|double)\b/.test(normalized)
    && !/(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(|var\(|currentcolor|white|black|transparent)/i.test(normalized)
  );
}
