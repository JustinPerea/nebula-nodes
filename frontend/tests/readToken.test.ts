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

  describe('tokenAtAlpha returns a plain rgba() string', () => {
    const at = (value: string, alpha = 0.6) => {
      document.body.style.setProperty('--sr-accent', value);
      return tokenAtAlpha('--sr-accent', alpha);
    };
    it('reads #rrggbb', () => expect(at('#abcdef')).toBe('rgba(171, 205, 239, 0.6)'));
    it('reads #rgb', () => expect(at('#fa0')).toBe('rgba(255, 170, 0, 0.6)'));
    it('reads #rrggbbaa and multiplies its own alpha', () => expect(at('#ff000080', 0.5)).toBe('rgba(255, 0, 0, 0.251)'));
    it('reads rgb()', () => expect(at('rgb(10, 20, 30)')).toBe('rgba(10, 20, 30, 0.6)'));
    it('reads rgb() in space syntax', () => expect(at('rgb(10 20 30 / 50%)', 0.5)).toBe('rgba(10, 20, 30, 0.25)'));
    it('reads rgba() and multiplies its own alpha', () => expect(at('rgba(110, 231, 183, 0.90)', 0.5)).toBe('rgba(110, 231, 183, 0.45)'));
    it('never returns color-mix', () => expect(at('#abcdef')).not.toContain('color-mix'));
    it('falls back to the token fallback when the value cannot be parsed', () => {
      expect(at('var(--nope)')).toBe('rgba(255, 90, 31, 0.6)');
      expect(at('hsl(10 50% 50%)')).toBe('rgba(255, 90, 31, 0.6)');
    });
    it('parses the other fallbacks too', () => {
      document.body.style.removeProperty('--sr-accent');
      expect(tokenAtAlpha('--sr-error', 1)).toBe('rgba(245, 197, 24, 1)');
      expect(tokenAtAlpha('--sr-success', 0.5)).toBe('rgba(110, 231, 183, 0.45)');
    });
  });
});
