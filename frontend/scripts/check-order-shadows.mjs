import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectCssFiles,
  compact,
  computeLineStarts,
  lineForOffset,
  parseDeclarations,
  parseRules,
  stripComments,
} from './lib/css-scan.mjs';

// Design: a modifier rule (`.block__el--mod { color: X }`) has the same specificity as its base
// rule (`.block__el { color: Y }`) when both carry the same ancestor prefix, so whichever comes
// later in the file wins. A base rule written after its modifier silently cancels the modifier.
// This reads every stylesheet under src and fails when a rule whose selector ends in a BEM
// modifier class sets a property that a LATER rule in the same file sets on the same selector
// without the modifier. Each selector of a comma list counts on its own. Rules inside an
// @media/@supports block are compared only with rules in that same block. Shorthand families
// (border and border-color, background and background-color) count as one property.
// Exempt a deliberate case with `order-shadow-exempt: <reason>` on the modifier rule's line.

const SRC = join(import.meta.dirname, '..', 'src');
const MODIFIER = /^(.*)\.([\w-]+?)--[\w-]+$/;

const family = (prop) => {
  if (prop === 'border' || prop === 'border-color') return 'border';
  if (prop === 'background' || prop === 'background-color') return 'background';
  return prop;
};

function splitList(selector) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((part) => compact(part.trim())).filter(Boolean);
}

/** Order shadows in one stylesheet: [{ file, modifier: { line, selector }, base: { line, selector }, prop }]. */
export function findOrderShadows(source, file) {
  const css = stripComments(source);
  const starts = computeLineStarts(css);
  const rawLines = source.split('\n');
  const rules = parseRules(css)
    .filter((rule) => !rule.nested)
    .map((rule) => {
      const line = lineForOffset(starts, rule.bodyStart - 1);
      const span = rule.selector.split('\n').length;
      const exempt = rawLines.slice(Math.max(0, line - span), line).some((text) => text.includes('order-shadow-exempt:'));
      const props = new Map();
      for (const decl of parseDeclarations(rule.body, rule.bodyStart)) props.set(family(decl.prop), decl.prop);
      return { ...rule, line, exempt, props, selectors: splitList(rule.selector) };
    });
  const hits = [];
  rules.forEach((rule, i) => {
    if (rule.exempt) return;
    for (const selector of rule.selectors) {
      const match = MODIFIER.exec(selector);
      if (!match) continue;
      const base = `${match[1]}.${match[2]}`;
      for (const [fam, prop] of rule.props) {
        const later = rules.slice(i + 1).find((other) => other.group === rule.group && other.props.has(fam) && other.selectors.includes(base));
        if (later) hits.push({ file, prop, modifier: { line: rule.line, selector }, base: { line: later.line, selector: base } });
      }
    }
  });
  return hits;
}

function main() {
  const files = collectCssFiles(SRC);
  const hits = [];
  for (const file of files) hits.push(...findOrderShadows(readFileSync(file, 'utf8'), relative(SRC, file)));
  if (hits.length > 0) {
    console.error('A base rule comes after its modifier rule at equal specificity, so it cancels the modifier. Move the modifier rule after the base (or add `order-shadow-exempt: <reason>` on the modifier rule).');
    for (const hit of hits) {
      console.error(`  src/${hit.file}:${hit.modifier.line} ${hit.modifier.selector} sets ${hit.prop}, overridden by src/${hit.file}:${hit.base.line} ${hit.base.selector}`);
    }
    process.exit(1);
  }
  console.log(`Order-shadow guard passed (${files.length} stylesheets scanned).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
