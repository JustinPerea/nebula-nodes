import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN_FALLBACKS, readToken, tokenAtAlpha, type PaletteToken } from '../src/lib/readToken';

const css = readFileSync(join(__dirname, '../src/styles/slava-restraint.css'), 'utf8');

/** A token's value in the body block, following one var() alias at a time. */
function cssValue(name: string): string {
  const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css);
  if (!m) throw new Error(`${name} is not defined in slava-restraint.css`);
  const alias = /^var\((--[\w-]+)\)$/.exec(m[1].trim());
  return alias ? cssValue(alias[1]) : m[1].trim();
}

const norm = (value: string) => value.replace(/\s+/g, '').replace(/(\.\d*?)0+(?=\)|$)/g, '$1').toLowerCase();

describe('readToken', () => {
  afterEach(() => document.body.style.removeProperty('--sr-accent'));

  it.each(Object.keys(TOKEN_FALLBACKS) as PaletteToken[])('the %s fallback equals the stylesheet value', (name) => {
    expect(norm(TOKEN_FALLBACKS[name])).toBe(norm(cssValue(name)));
  });

  it('returns the fallback when the page defines no such token', () => {
    expect(readToken('--sr-accent')).toBe(TOKEN_FALLBACKS['--sr-accent']);
  });

  it('reads the token from the body', () => {
    document.body.style.setProperty('--sr-accent', '#abcdef');
    expect(readToken('--sr-accent')).toBe('#abcdef');
  });

  it('mixes a share of the colour for a canvas fill', () => {
    document.body.style.setProperty('--sr-accent', '#abcdef');
    expect(tokenAtAlpha('--sr-accent', 0.6)).toBe('color-mix(in srgb, #abcdef 60%, transparent)');
  });
});
