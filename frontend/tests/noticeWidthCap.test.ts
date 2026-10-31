import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * GM - Design, 2026-10-23 (round 3, answer 5): "Two-line notices: keep
 * notices to one line in the copy. Cap their width at 560 px, and let a rare
 * second line overlap a panel's edge while it shows. Don't grow the band."
 *
 * Every item in the region's one stack (lib/noticeSlots.ts) is capped by one
 * token, the region's `--notice-max-w` (560 px): the canvas notice and the
 * late count, the toasts, the person-required line, the proposal's run-later
 * notice and the proposal bar, which is a stack item too (round 2 moved it
 * into the region's top slot). An item may be narrower (the pin error toast
 * stays 420 px); none may be wider. The band keeps `--notice-h`.
 */

const SRC = join(__dirname, '../src');

/** The root class of each stack item, as it renders into its slot. */
const ITEM_ROOTS = [
  'proposal-bar', 'proposal-bar--notice', 'person-required', 'project-switch-toast', 'project-home__toast',
  'canvas-pin-toast', 'moodboard-board-toast', 'asset-trash__toast', 'canvas-undo-notice',
];
const WIDTH_PROPS = ['width', 'max-width', '--proposal-bar-w'];

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

function rules(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let match = pattern.exec(bare); match; match = pattern.exec(bare)) out.push([match[1].trim(), match[2]]);
  return out;
}

function declarations(body: string): Array<[string, string]> {
  return body.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()] as [string, string];
  });
}

/** Whether a selector's last compound is one of the items' roots (not a part inside it). */
function targetsItemRoot(selector: string): boolean {
  return selector.split(',').some((part) => {
    const last = part.trim().split(/[\s>+~]+/).at(-1) ?? '';
    return ITEM_ROOTS.some((root) => new RegExp(`\\.${root.replace(/[-_]/g, (c) => `\\${c}`)}(?![\\w-])`).test(last));
  });
}

/** A width that can never exceed the cap: the token, a min() whose px are all within it, or a content size. */
function withinCap(value: string): boolean {
  if (value.includes('var(--notice-max-w')) return true;
  if (/^(max-content|min-content|fit-content|auto|100%|none)$/.test(value)) return false;
  const pixels = [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  return value.startsWith('min(') && pixels.length > 0 && pixels.some((px) => px <= 560)
    && pixels.filter((px) => px > 560).length === 0;
}

describe('notices are capped at 560 px', () => {
  it('the region sets the cap once, as a token, and every row reads it by default', () => {
    const css = readFileSync(join(SRC, 'styles/noticeRegion.css'), 'utf8');
    const region = rules(css).find(([selector]) => selector === '.notice-region')?.[1] ?? '';
    expect(declarations(region)).toContainEqual(['--notice-max-w', '560px']);
    const rows = rules(css).filter(([selector]) => /\.notice-region__slot\)?\s*>\s*\*/.test(selector));
    expect(rows.some(([, body]) => declarations(body).some(([prop, value]) => prop === 'max-width'
      && value.includes('var(--notice-max-w')))).toBe(true);
  });

  it('no stack item sets a width or max-width that can be wider', () => {
    const wide: string[] = [];
    for (const file of files(SRC, '.css')) {
      for (const [selector, body] of rules(readFileSync(file, 'utf8'))) {
        if (!targetsItemRoot(selector)) continue;
        for (const [prop, value] of declarations(body)) {
          if (!WIDTH_PROPS.includes(prop)) continue;
          // `width: var(--proposal-bar-w)` reads the custom property checked on its own.
          if (prop === 'width' && /^var\(--proposal-bar-w\)$/.test(value)) continue;
          if (prop === 'width' && value === 'max-content') continue;
          if (!withinCap(value)) wide.push(`${relative(SRC, file)}: ${selector} { ${prop}: ${value} }`);
        }
      }
    }
    expect(wide).toEqual([]);
  });

  // GM r13 (2), PR #204 round 9, supersedes round 3's "Don't grow the band": "The band reserves
  // the tallest single notice (three lines)." A one-line item is still --notice-h.
  it('the band is the tallest single notice (three lines) plus its gap', () => {
    const css = readFileSync(join(SRC, 'styles/noticeRegion.css'), 'utf8');
    const region = rules(css).find(([selector]) => selector === '.notice-region')?.[1] ?? '';
    expect(declarations(region)).toContainEqual(['--notice-h', '46px']);
    expect(declarations(region).some(([name]) => name === '--notice-tallest-h')).toBe(true);
    const band = rules(css).find(([selector]) => selector === '.notice-region__band')?.[1] ?? '';
    expect(declarations(band)).toContainEqual(['height', 'calc(var(--notice-tallest-h) + var(--notice-gap))']);
  });
});
