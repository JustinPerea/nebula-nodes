// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findOrderShadows } from '../scripts/check-order-shadows.mjs';

/**
 * scripts/check-order-shadows.mjs runs in `npm run lint` (design: a modifier rule written before
 * its base rule at equal specificity never shows). Each bad fixture must report; each fine one must not.
 */
const hits = (css: string) => findOrderShadows(css, 'fixture.css');
const P = 'body.app-slava-restraint';

describe('check-order-shadows', () => {
  it('fails the moodboard pattern: a modifier before its base, same prefix, same property', () => {
    const found = hits(`${P} .rail__empty--error { color: red; }\n${P} .rail__empty { color: grey; font-size: 11px; }`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ prop: 'color', modifier: { line: 1 }, base: { line: 2 } });
  });

  it('fails a block-level modifier (.block--mod) the same way', () => {
    expect(hits('.card--on { border-color: red; }\n.card { border: 1px solid grey; }')).toHaveLength(1);
  });

  it('treats border and border-color, background and background-color as one family', () => {
    expect(hits('.a--x { background-color: red; }\n.a { background: blue; }')).toHaveLength(1);
    expect(hits('.a--x { border: 1px solid red; }\n.a { border-color: blue; }')).toHaveLength(1);
  });

  it('passes the fixed order', () => {
    expect(hits(`${P} .rail__empty { color: grey; }\n${P} .rail__empty--error { color: red; }`)).toEqual([]);
  });

  it('passes different prefixes (different specificity)', () => {
    expect(hits(`${P} .a--x { color: red; }\n.a { color: grey; }`)).toEqual([]);
    expect(hits(`.a--x { color: red; }\n${P} .a { color: grey; }`)).toEqual([]);
  });

  it('passes different properties', () => {
    expect(hits('.a--x { color: red; }\n.a { font-size: 11px; }')).toEqual([]);
  });

  it('fails a comma-list member on its own', () => {
    const found = hits('.b { margin: 0; }\n.a--x,\n.b--y { color: red; }\n.b { color: grey; }');
    expect(found).toHaveLength(1);
    expect(found[0].modifier.selector).toBe('.b--y');
  });

  it('honours order-shadow-exempt on the modifier rule', () => {
    expect(hits('.a--x { /* order-shadow-exempt: the base is the fallback */ color: red; }\n.a { color: grey; }')).toEqual([]);
    expect(hits('.a--x,\n.c--y { /* order-shadow-exempt: reason */ color: red; }\n.a { color: grey; }')).toEqual([]);
  });

  it('compares inside one @media block only', () => {
    // A modifier inside a block is shadowed by a later base at the top level (an enclosing block).
    expect(hits('@media (min-width: 600px) { .a--x { color: red; } }\n.a { color: grey; }')).toHaveLength(1);
    expect(hits('.a--x { color: red; }\n@media (min-width: 600px) { .a { color: grey; } }')).toEqual([]);
    expect(hits('@media (min-width: 600px) { .a--x { color: red; }\n.a { color: grey; } }')).toHaveLength(1);
    expect(hits('@media (min-width: 600px) { .a--x { color: red; } }\n@media (min-width: 600px) { .a { color: grey; } }')).toEqual([]);
  });

  it('ignores a comment that mentions a selector', () => {
    expect(hits('/* .a--x { color: red; } */\n.a { color: grey; }')).toEqual([]);
  });

  it('skips a modifier declaration marked !important', () => {
    expect(hits('.a--x { color: red !important; }\n.a { color: grey; }')).toEqual([]);
    expect(hits('.a--x { color: red !important; margin: 0; }\n.a { color: grey; margin: 1px; }')).toHaveLength(1);
  });

  it('honours order-shadow-exempt on the line above the selector', () => {
    expect(hits('/* order-shadow-exempt: the base is the fallback */\n.a--x { color: red; }\n.a { color: grey; }')).toEqual([]);
    expect(hits('/* order-shadow-exempt: reason */\n.c--y,\n.a--x { color: red; }\n.a { color: grey; }')).toEqual([]);
    expect(hits('/* order-shadow-exempt: reason */\n.z { margin: 0; }\n.a--x { color: red; }\n.a { color: grey; }')).toHaveLength(1);
  });

  it('fails a modifier in a block when its base comes later at the top level', () => {
    const found = hits('@media (min-width: 600px) {\n  .a--x { color: red; }\n}\n.a { color: grey; }');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ modifier: { line: 2 }, base: { line: 4 } });
  });

  it('compares a modifier with a trailing pseudo-class or attribute against the same trailing part', () => {
    expect(hits('.a--m:hover { color: red; }\n.a:hover { color: grey; }')).toHaveLength(1);
    expect(hits('.a--m[aria-x] { color: red; }\n.a[aria-x] { color: grey; }')).toHaveLength(1);
    expect(hits('.a--m:hover { color: red; }\n.a { color: grey; }')).toEqual([]);
    expect(hits('.a--m { color: red; }\n.a:hover { color: grey; }')).toEqual([]);
  });
});
