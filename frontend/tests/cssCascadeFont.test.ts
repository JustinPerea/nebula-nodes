// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cascaded, declarationsOf, expandFont, parseRules, resolvedStyle } from './helpers/cssCascade';

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => { document.body.innerHTML = ''; });

/** The winner per key from one test sheet, with no app sheets (the element carries classes only the fixture uses). */
function winner(el: Element, css: string, key: string): string | undefined {
  return cascaded(el, css).get(key)?.value;
}

describe('the font shorthand against the longhands', () => {
  it('a more specific `font: inherit` beats a :where() longhand', () => {
    const host = mount('<div class="cc-a"><button class="cc-b">x</button></div>');
    const el = host.querySelector('button')!;
    const css = ':where(button) { font-family: Arial; } .cc-a .cc-b { font: inherit; }';
    expect(winner(el, css, '|font-family')).toBe('inherit');
    expect(winner(el, css, '|font')).toBe('inherit');
  });

  it('a later longhand in the same rule beats the shorthand before it', () => {
    const el = mount('<p class="cc-c"></p>').querySelector('p')!;
    const css = '.cc-c { font: inherit; font-size: 12px; }';
    expect(winner(el, css, '|font-size')).toBe('12px');
    expect(winner(el, css, '|font-family')).toBe('inherit');
  });

  it('a shorthand after a longhand in the same rule beats it', () => {
    const el = mount('<p class="cc-d"></p>').querySelector('p')!;
    expect(winner(el, '.cc-d { font-size: 12px; font: inherit; }', '|font-size')).toBe('inherit');
  });

  it('a more specific longhand beats a less specific shorthand', () => {
    const el = mount('<p class="cc-e cc-f"></p>').querySelector('p')!;
    const css = '.cc-e { font: 500 14px var(--sr-ui); } .cc-e.cc-f { font-size: 11px; }';
    expect(winner(el, css, '|font-size')).toBe('11px');
    expect(winner(el, css, '|font-weight')).toBe('500');
  });

  it('declarationsOf lists the shorthand as a candidate for a longhand, winner last', () => {
    const el = mount('<p class="cc-g"></p>').querySelector('p')!;
    const rules = parseRules(':where(p) { font-family: Arial; } p.cc-g { font: inherit; }');
    const list = declarationsOf(el, 'font-family', { rules });
    expect(list.map((w) => w.value)).toEqual(['Arial', 'inherit']);
  });
});

describe('inherit resolves from the ancestors', () => {
  it('from the parent', () => {
    const el = mount('<div class="cc-h"><span class="cc-i"></span></div>').querySelector('.cc-i')!;
    const css = '.cc-h { font-family: var(--sr-ui); } .cc-i { font-family: inherit; }';
    expect(resolvedStyle(el, css)['|font-family']).toBe('var(--sr-ui)');
  });

  it('from the grandparent through a parent that also inherits', () => {
    const el = mount('<div class="cc-j"><div class="cc-k"><span class="cc-l"></span></div></div>').querySelector('.cc-l')!;
    const css = '.cc-j { font-family: var(--sr-mono); } .cc-k, .cc-l { font-family: inherit; }';
    expect(resolvedStyle(el, css)['|font-family']).toBe('var(--sr-mono)');
  });

  it('through a font shorthand that wins', () => {
    const el = mount('<div class="cc-m"><input class="cc-n"></div>').querySelector('input')!;
    const css = '.cc-m { font-family: var(--sr-ui); } :where(input) { font-family: Arial; } .cc-m .cc-n { font: inherit; font-size: 12px; }';
    const style = resolvedStyle(el, css);
    expect(style['|font-family']).toBe('var(--sr-ui)');
    expect(style['|font-size']).toBe('12px');
    expect(style['|font']).toBe('inherit');
  });

  it('inherit with no ancestor declaration stays inherit', () => {
    const el = mount('<div class="cc-o"><span class="cc-p"></span></div>').querySelector('.cc-p')!;
    expect(resolvedStyle(el, '.cc-p { font-family: inherit; }')['|font-family']).toBe('inherit');
  });
});

describe('expandFont', () => {
  it('a full shorthand gives each longhand', () => {
    expect(expandFont("italic 600 12px/1.3 var(--sr-ui)")).toEqual({
      'font-style': 'italic', 'font-variant': 'normal', 'font-weight': '600', 'font-stretch': 'normal',
      'font-size': '12px', 'line-height': '1.3', 'font-family': 'var(--sr-ui)',
    });
  });

  it('a shorthand without weight resets weight to normal', () => {
    const out = expandFont('12px var(--sr-ui)');
    expect(out['font-weight']).toBe('normal');
    expect(out['line-height']).toBe('normal');
    expect(out['font-size']).toBe('12px');
  });

  it('a CSS-wide keyword goes to every longhand', () => {
    const out = expandFont('inherit');
    expect(Object.values(out)).toEqual(Array(7).fill('inherit'));
  });

  it('reads a spaced line-height and a family list', () => {
    const out = expandFont("bold 13px / 1.2 'JetBrains Mono', monospace");
    expect(out['font-weight']).toBe('bold');
    expect(out['line-height']).toBe('1.2');
    expect(out['font-family']).toBe("'JetBrains Mono', monospace");
  });

  it('a system font keyword is left as the family', () => {
    expect(expandFont('caption')).toEqual({ 'font-family': 'caption' });
  });
});
