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

/** A colour at a share of its opacity, for canvas fills (color-mix is a valid canvas colour). */
export function tokenAtAlpha(name: PaletteToken, alpha: number): string {
  return `color-mix(in srgb, ${readToken(name)} ${Math.round(alpha * 100)}%, transparent)`;
}
