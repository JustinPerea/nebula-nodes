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
    expect(hits('@media (min-width: 600px) { .a--x { color: red; } }\n.a { color: grey; }')).toEqual([]);
    expect(hits('.a--x { color: red; }\n@media (min-width: 600px) { .a { color: grey; } }')).toEqual([]);
    expect(hits('@media (min-width: 600px) { .a--x { color: red; }\n.a { color: grey; } }')).toHaveLength(1);
    expect(hits('@media (min-width: 600px) { .a--x { color: red; } }\n@media (min-width: 600px) { .a { color: grey; } }')).toEqual([]);
  });

  it('ignores a comment that mentions a selector', () => {
    expect(hits('/* .a--x { color: red; } */\n.a { color: grey; }')).toEqual([]);
  });
});
