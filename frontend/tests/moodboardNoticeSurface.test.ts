import { afterEach, describe, expect, it } from 'vitest';
import { resolvedStyle } from './helpers/cssCascade';

/**
 * #210 round 6s (GM r105 3): a Studio line on the board can sit over cards
 * (a panned view, #213 r3), so its surface is solid: the colour it has over
 * the empty canvas, wherever it is. The lines' own fill is a tint (the List
 * draws it over its panel), so on the board the tint is laid over the canvas
 * colour. Before this, the Slava skin's line rule (0,2,1) beat the board's
 * `> *` rule (0,1,0) and the line was its bare tint, 3.5% white or 30% black,
 * see-through over a green or orange card.
 *
 * The ratchet: every kind of line, skinned or not, has a background whose
 * bottom layer is an opaque colour, takes no opacity below 1 and no backdrop
 * filter, and over that base draws the same tint the line has elsewhere.
 */
const KINDS = [
  'moodboard-studio__notice moodboard-studio__notice--error',
  'moodboard-studio__notice moodboard-studio__notice--warn',
  'moodboard-studio__notice moodboard-studio__notice--neutral',
  'moodboard-studio__notice moodboard-studio__notice--neutral moodboard-studio__notice--action',
  'moodboard-studio__notice moodboard-studio__notice--error moodboard-studio__notice--action',
];

const lineIn = (className: string, skinned: boolean, onBoard = true) => {
  document.body.className = skinned ? 'app-slava-restraint' : '';
  const view = document.createElement('div');
  view.className = onBoard ? 'moodboard-studio-view moodboard-studio-view--board' : 'moodboard-studio-view';
  const main = document.createElement('main');
  main.className = onBoard ? 'moodboard-studio-view__board' : 'moodboard-studio-view__main';
  const stack = document.createElement('div');
  if (onBoard) stack.className = 'moodboard-studio-view__board-notices';
  const line = document.createElement('div');
  line.className = className;
  stack.append(line);
  main.append(stack);
  view.append(main);
  document.body.append(view);
  return line;
};

/** Splits at top-level commas (not those inside a function's brackets). */
function topLevel(value: string, separator: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      if (part.trim()) out.push(part.trim());
      part = '';
    } else part += ch;
  }
  if (part.trim()) out.push(part.trim());
  return out;
}

/** `value` with every var() replaced by the custom property the element has (or the fallback). */
function resolve(value: string, style: Record<string, string>, depth = 0): string {
  if (depth > 20) throw new Error(`var() loop in ${value}`);
  const at = value.indexOf('var(');
  if (at < 0) return value;
  let close = at + 4;
  for (let open = 1; open > 0; close += 1) {
    if (value[close] === '(') open += 1;
    if (value[close] === ')') open -= 1;
  }
  const inner = value.slice(at + 4, close - 1);
  const name = topLevel(inner, ',')[0];
  const fallback = inner.includes(',') ? inner.slice(inner.indexOf(',') + 1).trim() : undefined;
  const found = style[`|${name.trim()}`] ?? fallback;
  if (found === undefined) throw new Error(`${name} is not set`);
  return resolve(value.slice(0, at) + resolve(found, style, depth + 1) + value.slice(close), style, depth + 1);
}

function isOpaque(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(c) || /^#[0-9a-f]{6}$/.test(c)) return true;
  if (/^#[0-9a-f]{8}$/.test(c)) return c.endsWith('ff');
  if (/^#[0-9a-f]{4}$/.test(c)) return c.endsWith('f');
  const fn = /^rgba?\((.*)\)$/.exec(c);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length === 3 || Number(parts[3]) === 1 || parts[3] === '100%';
  }
  return false;
}

afterEach(() => { document.body.innerHTML = ''; document.body.className = ''; });

describe('a line on the board has a solid surface (GM r105 3)', () => {
  for (const skinned of [true, false]) {
    for (const kind of KINDS) {
      it(`${skinned ? 'Slava skin' : 'no skin'}: ${kind.split(' ').slice(1).join(' ')}`, () => {
        const style = resolvedStyle(lineIn(kind, skinned));
        const background = style['|background'] ?? style['|background-color'];
        expect(background, 'the line sets its own background').toBeTruthy();
        const layers = topLevel(resolve(background, style), ',');
        expect(isOpaque(layers[layers.length - 1]), `bottom layer "${layers[layers.length - 1]}" is opaque`).toBe(true);
        expect(style['|background-color'] === undefined || isOpaque(resolve(style['|background-color'], style))).toBe(true);
        expect(Number(style['|opacity'] ?? '1')).toBe(1);
        expect(style['|backdrop-filter'] ?? 'none').toBe('none');
      });
    }
  }

  it('over the canvas it is the colour it was over the empty canvas: the line\'s own tint on the canvas colour', () => {
    for (const kind of KINDS) {
      const style = resolvedStyle(lineIn(kind, true));
      const layers = topLevel(resolve(style['|background'], style), ',');
      const tint = resolve(style['|--mb-notice-fill'], style);
      expect(layers).toEqual([`linear-gradient(${tint}, ${tint})`, resolve('var(--mb-board-bg)', style)]);
      document.body.innerHTML = '';
    }
  });

  it('in the List (not over the canvas) the line keeps its tint as before', () => {
    const style = resolvedStyle(lineIn('moodboard-studio__notice moodboard-studio__notice--neutral', true, false));
    expect(resolve(style['|background'], style)).toBe(resolve('var(--sr-surface-control)', style));
    document.body.innerHTML = '';
    const error = resolvedStyle(lineIn('moodboard-studio__notice moodboard-studio__notice--error', true, false));
    expect(resolve(error['|background'], error)).toBe('rgba(255, 255, 255, 0.035)');
  });
});
