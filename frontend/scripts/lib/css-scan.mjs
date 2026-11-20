import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The small CSS reader the stylesheet checks share (check-slava-css-scope.mjs,
// check-left-edge.mjs): list the .css files, split a sheet into rules and a rule
// into declarations, and tell a neutral value from a coloured one.

export const NEUTRAL_VALUES = [
  /^none(?:\s*!important)?$/i,
  /^0(?:\s*!important)?$/i,
  /^0px(?:\s*!important)?$/i,
  /^transparent(?:\s*!important)?$/i,
  /^inherit(?:\s*!important)?$/i,
  /^currentcolor(?:\s*!important)?$/i,
  /^unset(?:\s*!important)?$/i,
  /^initial(?:\s*!important)?$/i,
];

export function collectCssFiles(dir) {
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

export function parseRules(css, baseOffset = 0) {
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

export function findMatchingBrace(css, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

export function findSelectorStart(css, openIndex) {
  const prevClose = css.lastIndexOf('}', openIndex);
  const prevSemicolon = css.lastIndexOf(';', openIndex);
  const prevBoundary = Math.max(prevClose, prevSemicolon);
  return prevBoundary + 1;
}

export function parseDeclarations(body, bodyStart) {
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

export function isNeutralValue(value) {
  const normalized = value.trim().toLowerCase();
  return NEUTRAL_VALUES.some((pattern) => pattern.test(normalized));
}

export function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

export function lineForOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

export function compact(selector) {
  return selector.replace(/\s+/g, ' ');
}

/** The sheet with its comments blanked to spaces (newlines kept), so offsets and line numbers stay true. */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}
