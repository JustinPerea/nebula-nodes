import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom applies no author stylesheet, so a test of the `hidden` attribute passes while Chrome draws
// the element (a class with display: flex beats the browser's own [hidden] rule). The app's base
// stylesheet (App.css, the first one loaded) resets it, with !important so no display rule beats it.
const SRC = resolve(__dirname, '../src');
const baseCss = readFileSync(resolve(SRC, 'App.css'), 'utf8');

describe('the hidden attribute', () => {
  it('is reset to display: none !important in the base stylesheet, except until-found', () => {
    const rule = /\[hidden\]:not\(\[hidden="until-found"\]\)\s*\{([^}]*)\}/.exec(baseCss);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/display:\s*none\s*!important/);
  });

  it('is in App.css, which App.tsx imports', () => {
    expect(readFileSync(resolve(SRC, 'App.tsx'), 'utf8')).toMatch(/import '\.\/App\.css';/);
  });
});
