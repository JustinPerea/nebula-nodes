// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findSystemFonts, firstFamilyOf, hasBaseRule, scan } from '../scripts/check-system-fonts.mjs';

/**
 * scripts/check-system-fonts.mjs runs in `npm run lint` (design: one face everywhere, the app face;
 * and the base rule that lets a button or field inherit it). Each bad fixture must report; each fine
 * one must not.
 */
const BASE = ':where(button, input, select, textarea) { font: inherit; }\n';
const sheet = (source: string) => [{ file: 'fixture.css', source }];
const hits = (rules: string) => findSystemFonts(sheet(rules));

describe('check-system-fonts: banned first families', () => {
  it.each([
    ['-apple-system', ".a { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }"],
    ['BlinkMacSystemFont', '.a { font-family: BlinkMacSystemFont, sans-serif; }'],
    ['system-ui', '.a { font-family: system-ui, sans-serif; }'],
    ['ui-sans-serif', '.a { font-family: ui-sans-serif, sans-serif; }'],
    ['a quoted Segoe UI', ".a { font-family: 'Segoe UI', Tahoma, sans-serif; }"],
    ['Arial', '.a { font-family: Arial, sans-serif; }'],
    ['Helvetica', '.a { font-family: Helvetica, Arial, sans-serif; }'],
    ['a bare sans-serif', '.a { font-family: sans-serif; }'],
    ['a bare serif', '.a { font-family: serif; }'],
    ['uppercase and !important', '.a { font-family: ARIAL !important; }'],
    ['the prefixed twin', 'body.app-slava-restraint .a { font-family: system-ui; }'],
    ['inside an @media block', '@media (min-width: 1px) { .a { font-family: system-ui, sans-serif; } }'],
    ['the font shorthand', '.a { font: 600 12px/1.4 -apple-system, sans-serif; }'],
    ['the shorthand with a keyword size', '.a { font: bold small Arial, sans-serif; }'],
    ['the shorthand with a token line height', '.a { font: 500 12px/var(--lh, 1.4) system-ui, sans-serif; }'],
    ['the shorthand with a token size', '.a { font: 500 var(--size, 12px) system-ui, sans-serif; }'],
  ])('fails %s', (_name, rules) => {
    const found = hits(rules);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(1);
  });

  it('reports the line of the declaration', () => {
    const found = hits('.a {\n  color: red;\n  font-family: Arial;\n}\n');
    expect(found.map((hit) => hit.line)).toEqual([3]);
  });

  it('reports each bad declaration once', () => {
    expect(hits('.a { font-family: Arial; }\n.b { font-family: system-ui; }\n.c { font-family: var(--sr-ui); }')).toHaveLength(2);
  });
});

describe('check-system-fonts: what passes', () => {
  it.each([
    ['a var() with a system fallback', ".a { font-family: var(--sr-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); }"],
    ['a var() with a bare fallback', '.a { font-family: var(--sr-ui, sans-serif); }'],
    ['a plain var()', '.a { font-family: var(--sr-ui); }'],
    ['the shorthand with a var() family', '.a { font: 600 11px/14px var(--sr-font-sans, system-ui, sans-serif); }'],
    ['the shorthand with a var() family and a token size', '.a { font: 500 var(--size, 12px)/1 var(--sr-ui, system-ui); }'],
    ['inherit', '.a { font-family: inherit; }'],
    ['the shorthand inherit', '.a { font: inherit; }'],
    ['a shorthand with no family', '.a { font: 12px/1.4; }'],
    ['the named app face', ".a { font-family: 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif; }"],
    ['Helvetica Neue first', ".a { font-family: 'Helvetica Neue', Arial; }"],
    ['a mono stack', ".a { font-family: 'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', Menlo, monospace; }"],
    ['a bare monospace', '.a { font-family: monospace; }'],
    ['ui-monospace', '.a { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }'],
    ['a face name that only contains a system name', ".a { font-family: 'Arial Black', sans-serif; }"],
    ['a system face named in a comment', '/* font-family: Arial; */ .a { color: red; }'],
    ['a system face in another property', '.a { content: "font-family: Arial"; font-size: 12px; }'],
    ['a custom property that holds a stack', '.a { --x: system-ui, sans-serif; }'],
  ])('passes %s', (_name, rules) => {
    expect(hits(rules)).toEqual([]);
  });

  it('reads the first family of each form', () => {
    expect(firstFamilyOf('font-family', "'Segoe UI', sans-serif")).toBe('segoe ui');
    expect(firstFamilyOf('font', '600 12px/1.4 Arial, sans-serif')).toBe('arial');
    expect(firstFamilyOf('font', '12px var(--x, Arial)')).toBeNull();
    expect(firstFamilyOf('font-family', 'inherit')).toBeNull();
  });
});

describe('check-system-fonts: the base rule', () => {
  it('passes when the rule is there', () => {
    expect(scan(sheet(BASE))).toEqual({ hits: [], baseRule: true });
  });

  it('fails when it is absent', () => {
    expect(scan(sheet('.a { color: red; }')).baseRule).toBe(false);
    expect(scan([]).baseRule).toBe(false);
  });

  it.each([
    ['one of the four tags missing', ':where(button, input, select) { font: inherit; }'],
    ['a different declaration', ':where(button, input, select, textarea) { font-family: inherit; }'],
    ['a value that is not inherit', ':where(button, input, select, textarea) { font: 12px Inter; }'],
    ['a plain selector, which carries specificity', 'button, input, select, textarea { font: inherit; }'],
    ['an :is() selector, which takes the specificity of its list', ':is(button, input, select, textarea) { font: inherit; }'],
    ['a scoped selector', 'body :where(button, input, select, textarea) { font: inherit; }'],
    ['the rule inside a media query', '@media (min-width: 1px) { :where(button, input, select, textarea) { font: inherit; } }'],
    ['the rule only in a comment', '/* :where(button, input, select, textarea) { font: inherit; } */'],
  ])('fails with %s', (_name, source) => {
    expect(hasBaseRule(sheet(source))).toBe(false);
  });

  it('accepts any tag order, spacing and !important', () => {
    expect(hasBaseRule(sheet(':where(textarea,select,input,button){font:inherit !important}'))).toBe(true);
  });

  it('finds the rule in any one sheet of several', () => {
    expect(hasBaseRule([...sheet('.a { color: red; }'), { file: 'b.css', source: BASE }])).toBe(true);
  });
});
