/**
 * A palette token read at draw time, for the places that paint with a canvas API and cannot
 * use var(): a favicon dot, a waveform. The value is the token's computed value on <body>
 * (where body.app-slava-restraint defines it); the fallback is used when the page has no such
 * token (a test, a page without the stylesheet).
 *
 * TOKEN_FALLBACKS equals the token values in styles/slava-restraint.css, and
 * tests/readToken.test.ts fails when they drift apart.
 */
export const TOKEN_FALLBACKS = {
  // palette-exempt: the --sr-error value (--sr-warning), pinned to the stylesheet by tests/readToken.test.ts
  '--sr-error': '#F5C518',
  // palette-exempt: the --sr-success value, pinned to the stylesheet by tests/readToken.test.ts
  '--sr-success': 'rgba(110, 231, 183, 0.90)',
  // palette-exempt: the --sr-accent value, pinned to the stylesheet by tests/readToken.test.ts
  '--sr-accent': '#FF5A1F',
} as const;

export type PaletteToken = keyof typeof TOKEN_FALLBACKS;

export function readToken(name: PaletteToken): string {
  const fallback = TOKEN_FALLBACKS[name];
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  try {
    const value = getComputedStyle(document.body ?? document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

type Rgba = [number, number, number, number];

const channelValue = (text: string) => (text.endsWith('%') ? (parseFloat(text) / 100) * 255 : parseFloat(text));
const alphaValue = (text: string) => (text.endsWith('%') ? parseFloat(text) / 100 : parseFloat(text));

/** #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba() (comma or space syntax) as [r, g, b, a], or null. */
function parseColour(value: string): Rgba | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]+)$/i.exec(text);
  if (hex && [3, 4, 6, 8].includes(hex[1].length)) {
    const full = hex[1].length <= 4 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    const [r, g, b, a] = [0, 2, 4, 6].map((i) => (full.length > i ? parseInt(full.slice(i, i + 2), 16) : 255));
    return [r, g, b, a / 255];
  }
  const fn = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(text);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : alphaValue(fn[4]);
    const out: Rgba = [channelValue(fn[1]), channelValue(fn[2]), channelValue(fn[3]), alpha];
    return out.every(Number.isFinite) ? out : null;
  }
  return null;
}

/**
 * A colour at a share of its own opacity, as a plain rgba() string. A canvas fill (WaveSurfer's
 * progressColor) may not accept color-mix(), and a colour it rejects draws black, so the token's
 * value is parsed here. A value that can't be parsed falls back to the token's fallback.
 */
export function tokenAtAlpha(name: PaletteToken, alpha: number): string {
  const [r, g, b, a] = parseColour(readToken(name)) ?? (parseColour(TOKEN_FALLBACKS[name]) as Rgba);
  const mixed = Math.round(Math.min(1, Math.max(0, a * alpha)) * 1000) / 1000;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${mixed})`;
}
