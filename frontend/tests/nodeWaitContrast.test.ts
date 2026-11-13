import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM - Design, PR #212 round 3, the contrast defect: "Waiting for your OK" is
 * one ink at 4.5:1 or better on the header's tint in every state, selected or
 * not (the app has one skin, Slava Restraint). The ratio is worked out from
 * the real CSS: the tokens are read from node-wait.css and slava-restraint.css,
 * the tint is the rule's colour-mix over an opaque base, and the accent is any
 * agent's colour (an agent may name its own, #RRGGBB), so the brightest there
 * can be, white, is the worst case.
 */
const styles = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8');
const wait = styles('node-wait.css');
const restraint = styles('slava-restraint.css');

type Rgba = [number, number, number, number];
function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgba = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgba) {
    const p = rgba[1].split(',').map((x) => Number(x.trim()));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  throw new Error(`cannot read ${value}`);
}
/** A custom property's value on body.app-slava-restraint, var() chains followed. */
function token(name: string, depth = 0): string {
  const own = new RegExp(`${name}:\\s*([^;]+);`);
  const found = own.exec(wait) ?? own.exec(restraint);
  if (!found) throw new Error(`${name} is not defined`);
  const value = found[1].replace(/\/\*.*$/, '').trim();
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  return ref && depth < 8 ? token(ref[1], depth + 1) : value;
}
const over = (top: Rgba, under: Rgba): Rgba => {
  const a = top[3] + under[3] * (1 - top[3]);
  return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a) as Rgba;
};
const luminance = ([r, g, b]: Rgba) => {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** The header's tint, as the rule mixes it: accent at --sr-wait-tint over --sr-wait-base. */
function tint(accent: string): Rgba {
  const share = Number(/^(\d+(?:\.\d+)?)%$/.exec(token('--sr-wait-tint'))![1]) / 100;
  const base = parseColor(token('--sr-wait-base'));
  const a = parseColor(accent);
  return [0, 1, 2].map((i) => a[i] * share + base[i] * (1 - share)).concat(1) as Rgba;
}
/** The label's ink on that tint (the ink's own alpha counts). */
const ink = (): Rgba => parseColor(token('--sr-wait-ink'));

const ACCENTS = ['#FFFFFF', '#E8825A', '#5B9DFF', '#3FC1A5', '#F2C14E', '#FF6B9A', '#7AD3FF', '#C3E86B', '#FF9F43', '#c7f36b', '#000000'];

describe('the waiting label\'s contrast', () => {
  it('is 4.5:1 or better on the tint for every accent, the brightest (white) included', () => {
    const measured = ACCENTS.map((accent) => [accent, ratio(over(ink(), tint(accent)), tint(accent))] as const);
    for (const [accent, r] of measured) expect(r, `${accent} -> ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('reads the tint on an opaque base, so what the label sits on never depends on the card behind the header', () => {
    expect(parseColor(token('--sr-wait-base'))[3]).toBe(1);
    expect(wait).toMatch(/color-mix\(in srgb, var\(--agent-color\) var\(--sr-wait-tint\), var\(--sr-wait-base\)\)/);
    // Wins over a surface that clears its header (an image preview's): one more class than that rule.
    expect(wait).toMatch(/\.model-node__card \.model-node__header\[data-waiting='true'\]/);
    expect(wait).toMatch(/background-image:\s*none/);
  });

  it('is the same ratio on the pill over media (GM r5 ruling 2): the pill is the same opaque tint, the ink the same white', () => {
    const pill = /node-wait-swap__label::before \{[^}]*background-color:\s*([^;]+);/.exec(wait)![1];
    expect(pill).toBe('color-mix(in srgb, var(--agent-color) var(--sr-wait-tint), var(--sr-wait-base))');
    // The pill is an opaque base mixed with the accent, so nothing of the preview shows through it.
    expect(parseColor(token('--sr-wait-base'))[3]).toBe(1);
    expect(wait).not.toMatch(/node-wait-swap__label::before \{[^}]*opacity/);
    const worst = Math.min(...ACCENTS.map((accent) => ratio(over(ink(), tint(accent)), tint(accent))));
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it('is one ink: the label sets it once, no state (selected, hover, focus) or opacity changes it', () => {
    const rules = [...wait.matchAll(/([^{}]*node-wait-swap__label[^{}]*)\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
    const colours = rules.filter((r) => /(^|[;\s{])color:/.test(r.body));
    expect(colours).toHaveLength(1);
    expect(colours[0].body).toMatch(/color:\s*var\(--sr-wait-ink\)/);
    // (The over-media rules only place the pill; they set no ink.)
    for (const r of rules.filter((x) => !x.selector.includes(':has('))) expect(r.selector).not.toMatch(/selected|hover|focus|:not\(|disabled/);
    // Nothing else in the app restyles the label.
    expect(restraint).not.toContain('node-wait-swap__label');
    // Fully opaque once on (the fade is only the crossfade).
    expect(wait).toMatch(/\.node-wait-swap\[data-on='true'\] \.node-wait-swap__label \{\s*opacity: 1;/);
  });

  it('the ink token is the white the app uses for its brightest type', () => {
    expect(token('--sr-wait-ink')).toBe('#FFFFFF');
  });
});
