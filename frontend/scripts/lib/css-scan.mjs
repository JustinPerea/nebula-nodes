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

    // A rule starts after the previous one closed (cursor) or after a stray statement's semicolon (@import ...;).
    const selectorStart = Math.max(cursor, findSelectorStart(css, open));
    const selector = css.slice(selectorStart, open).trim();
    const body = css.slice(open + 1, close);

    if (selector.startsWith('@')) {
      rules.push(...parseRules(body, baseOffset + open + 1));
    } else if (selector) {
      rules.push({
        selector,
        body,
        bodyStart: baseOffset + open + 1,
        // Nested CSS (`&` rules, or a `{` between declarations): the declaration reader below can't split it.
        nested: bodyHasBrace(body),
      });
    }

    cursor = close + 1;
  }
  return rules;
}

/** The index of the brace that closes the one at openIndex. A brace inside a quoted string (content: "}") doesn't count. */
export function findMatchingBrace(css, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < css.length; i += 1) {
    const char = css[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

/** Whether a rule body holds a `{` outside quoted strings. */
export function bodyHasBrace(body) {
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{') {
      return true;
    }
  }
  return false;
}

export function findSelectorStart(css, openIndex) {
  const prevClose = css.lastIndexOf('}', openIndex);
  const prevSemicolon = css.lastIndexOf(';', openIndex);
  const prevBoundary = Math.max(prevClose, prevSemicolon);
  return prevBoundary + 1;
}

/** Split a rule body on `;` outside quoted strings and parentheses (a url(data:...;base64,...) keeps its semicolon). */
function splitDeclarations(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote) {
      current += char;
      if (char === '\\' && i + 1 < body.length) {
        i += 1;
        current += body[i];
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ';' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

export function parseDeclarations(body, bodyStart) {
  const declarations = [];
  const parts = splitDeclarations(body);
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
