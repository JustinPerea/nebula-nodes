// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ALLOWED, findLeftEdges, isAllowed, isNeutralColor, staleAllowed } from '../scripts/check-left-edge.mjs';
import { scanSource } from '../scripts/check-inline-styles.mjs';
import { collectVars } from '../scripts/lib/css-values.mjs';

/**
 * scripts/check-left-edge.mjs runs in `npm run lint`: no stylesheet paints an accent edge down
 * the left side of a block (design), however the edge is written. Each fixture is one rule;
 * `bars` must be caught (one hit each), `fine` must pass. The custom properties below stand in
 * for the app's: the check resolves var() through every definition it is given.
 */

type Hit = { file: string; selector: string; decl: string; reason: string };
const VARS = collectVars([`
  :root {
    --sr-edge: rgba(255, 255, 255, 0.06);
    --sr-edge-strong: rgba(255, 255, 255, 0.12);
    --mb-board-edge-strong: #333;
    --sr-ink-light: #888;
    --an-edge: #444;
    --sr-accent: #5b9dff;
    --chat-accent: #ff5a1f;
    --an-author: hsl(20 90% 50%);
    --pin-color: #e8a33d;
    --an-shadow: 0 8px 24px rgb(0 0 0 / 0.4);
    --w: 3px;
    --hair: 1px;
    --viewport-w: 2vw;
    --alias: var(--sr-accent);
    --hairline-edge: #5b9dff;
    --rail-ink: 4px;
  }
  body.theme-a { --tint-edge: #444; --wide: 1px; }
  body.theme-b { --tint-edge: #d9822b; --wide: 4px; }
  body.theme-olive { --olive-edge: #536047; }
`]);
const found = (css: string, file = 'styles/x.css', vars = VARS) => (findLeftEdges(css, file, vars) as Hit[]).filter((hit) => !isAllowed(hit));

describe('the left-edge check fails on', () => {
  const bars = [
    // border-left
    '.a { border-left: 3px solid var(--agent-color); }',
    '.a { border-left: 2px solid #444; }',
    '.a { border-left: 2px solid; }',
    '.a { border-left: 0.25rem solid #444; }',
    '.a { border-left: solid thick; }',
    '.a { border-left: var(--w) solid #444; }',
    '.a { border-left-width: 3px; }',
    '.a { border-left: 1px solid var(--agent-color); }',
    '.a { border-left: 1px solid #5b9dff; }',
    '.a { border-left: 1px solid rgb(91 157 255 / 0.5); }',
    '.a { border-left: 1px solid var(--sr-accent); }',
    '.a { border-left-color: var(--chat-accent); }',
    '.a { border-left-color: hsl(20 90% 50%); }',
    // border-inline-start
    '.a { border-inline-start: 3px solid #444; }',
    '.a { border-inline-start: 1px solid var(--agent-color); }',
    '.a { border-inline-start-width: 2px; }',
    '.a { border-inline-start-color: var(--sr-accent); }',
    // inset box-shadow
    '.a { box-shadow: inset 4px 0 0 var(--c); }',
    '.a { box-shadow: inset 4px 0 0 color-mix(in srgb, var(--an-author) 70%, transparent); }',
    '.a { box-shadow: 4px 0 0 red inset; }',
    '.a { box-shadow: var(--an-shadow), inset 4px 0 0 red; }',
    '.a { box-shadow: 0 0 0 1px red, inset 3px 0 0 0 rgb(1 2 3 / 0.5); }',
    // a pseudo-element stripe
    '.a::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--c); }',
    '.a::after { position: absolute; inset-inline-start: 0; width: 4px; height: 100%; background-color: #5b9dff; }',
    '.a:hover::before { position: absolute; left: 0px; width: 2px; height: 20px; background: red; }',
    '.a, .b::before { position: absolute; left: 0; width: 4px; top: 2px; bottom: 9px; background: red; }',
    '.a::before { position: absolute; left: 0; width: 3px; top: 0; bottom: 0; background: red; }',
    '.a::before { position: absolute; left: 0; width: 3px; height: 100%; background: red; }',
    // (a) a stripe is any element, not only ::before / ::after: the pin card's edge span, as it was
    '.canvas-pin__edge { position: absolute; top: -1px; bottom: -1px; left: -1px; width: 3px; border-radius: 6px 0 0 6px; background: var(--pin-color); pointer-events: none; }',
    '.a { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--sr-accent); }',
    '.a { position: absolute; left: -2px; top: 0; height: 100%; width: 4px; background-color: #5b9dff; }',
    '.a { position: absolute; inset-inline-start: 0; inset-block: 0; width: 3px; background: red; }',
    '.a { position: absolute; inset: 0 auto 0 0; width: 3px; background: red; }',
    '.a { position: absolute; left: 0; top: 0; height: 40px; width: 3px; background-image: linear-gradient(red, blue); }',
    '.a { position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: var(--sr-accent); }',
    '.a { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--sr-edge); }',
    // (b) a border shorthand with no readable width: a style alone is medium, 3px
    '.a { border-left: solid red; }',
    '.a { border-left: solid; }',
    '.a { border-left: 2vw solid #444; }',
    '.a { border-left: 1vh solid #444; }',
    '.a { border-left: 1ch solid #444; }',
    '.a { border-left: 1ex solid #444; }',
    '.a { border-left: 2cqw solid #444; }',
    '.a { border-left: calc(100% - 1px) solid #444; }',
    '.a { border-left: calc(1px + 1px) solid #444; }',
    '.a { border-left: var(--viewport-w) solid #444; }',
    '.a { border-left: var(--nope) solid #444; }',
    '.a { border-left-width: 2vw; }',
    '.a { border-inline-start: solid red; }',
    '.a { border-inline-start: 2vw solid #444; }',
    '.a { border-inline-start-width: calc(100% - 1px); }',
    // (c) the left value of border-width / border-color lists
    '.a { border-width: 0 0 0 3px; }',
    '.a { border-width: 1px 1px 1px 4px; }',
    '.a { border-width: 0 0 0 3px; border-style: solid; }',
    '.a { border-width: 0 0 0 2vw; }',
    '.a { border-width: 0 0 0 1px; border-color: transparent transparent transparent red; }',
    '.a { border-width: 0 0 0 1px; border-color: #444 #444 #444 var(--sr-accent); }',
    '.a { border-color: red red red blue; }',
    // (d) var() resolved through every definition: none is read by its name
    '.a { border-left: 1px solid var(--tint-edge); }',
    '.a { border-left: 1px solid #5b9dff; }',
    '.a { border-left: 1px solid color-mix(in srgb, var(--agent-color) 30%, transparent); }',
    '.a { border-left: var(--wide) solid #444; }',
    '.a { border-left-color: var(--nope); }',
    '.a { border-left: 1px solid var(--nope); }',
    '.a { border-left: 1px solid var(--hairline-edge); }',
    '.a { border-left: var(--rail-ink) solid #444; }',
    '.a { border-left: 1px solid var(--alias); }',
    '.a { border-left-color: var(--sr-edge-accent, var(--sr-accent)); }',
    // (e) an inset x offset written as var() or calc(), and an outer bar
    '.a { box-shadow: inset var(--w) 0 0 red; }',
    '.a { box-shadow: inset var(--nope) 0 0 red; }',
    '.a { box-shadow: inset calc(2px + 2px) 0 0 red; }',
    '.a { box-shadow: inset calc(100% - 1px) 0 0 red; }',
    '.a { box-shadow: inset 2vw 0 0 red; }',
    '.a { box-shadow: inset 4px 0 4px red; }',
    '.a { box-shadow: inset 2px 0 0 #444; }',
    '.a { box-shadow: -3px 0 0 red; }',
    '.a { box-shadow: -2px 0 0 0 #5b9dff; }',
    '.a { box-shadow: -2px 0 0 #444; }',
    '.a { box-shadow: 0 8px 24px rgb(0 0 0 / 0.4), -4px 0 0 red; }',
  ];
  it.each(bars)('%s', (css) => {
    expect(found(css)).toHaveLength(1);
  });

  it('a rule inside @media, with its line number', () => {
    const hits = findLeftEdges('/* c */\n@media (min-width: 1px) {\n  .a {\n    border-left: 4px solid red;\n  }\n}\n', 'styles/x.css', VARS) as Array<Hit & { line: number }>;
    expect(hits.map((hit) => [hit.selector, hit.line])).toEqual([['.a', 4]]);
  });

  it('a bar written inside a comment is not read, and a brace in a comment does not hide the next rule', () => {
    expect(found('/* .a { border-left: 3px solid red; } */ .b { border-left: 3px solid red; }').map((hit) => hit.selector)).toEqual(['.b']);
    expect(found('/* } { */ .b { box-shadow: inset 4px 0 0 red; }').map((hit) => hit.selector)).toEqual(['.b']);
  });

  // (g) css-scan
  describe('nested CSS and braces in strings', () => {
    it.each([
      '.a { color: red; &:hover { border-left: 3px solid red; } }',
      '.a { & .b { color: red; } }',
      '.a { .b { x: y; } }',
      '.a { color: red; @media (min-width: 1px) { border-left: 3px solid red; } }',
    ])('%s is "nested CSS isn\'t read by this check"', (css) => {
      const hits = found(css);
      expect(hits).toHaveLength(1);
      expect(hits[0].reason).toMatch(/nested CSS isn't read by this check/);
    });

    it('a } inside a string does not end the rule, so the next rule is still read', () => {
      expect(found('.a { content: "}"; } .b { border-left: 3px solid red; }').map((hit) => hit.selector)).toEqual(['.b']);
      expect(found(".a::before { content: '}}'; } .b { border-left: 3px solid red; }").map((hit) => hit.selector)).toEqual(['.b']);
    });

    it('a { inside a string is not nested CSS and does not hide the next rule', () => {
      expect(found('.a::before { content: "{"; } .b { border-left: 3px solid red; }').map((hit) => hit.selector)).toEqual(['.b']);
      expect(found('.a::before { content: "{"; }')).toEqual([]);
    });
  });
});

describe('the left-edge check passes', () => {
  const fine = [
    // a 1px neutral divider
    '.a { border-left: 1px solid var(--sr-edge-strong); }',
    '.a { border-left: 1px solid var(--sr-edge, rgb(255 255 255 / 0.12)); }',
    '.a { border-left: 1px solid var(--mb-board-edge-strong); }',
    '.a { border-left: 1px solid rgb(255 255 255 / 0.12); }',
    '.a { border-left: 1px solid #333; }',
    '.a { border-left: 0.0625rem solid hsl(0 0% 50%); }',
    '.a { border-left: 1px solid transparent; }',
    '.a { border-left: 1px solid; }',
    '.a { border-left: 0; }',
    '.a { border-left: none; }',
    '.a { border-left-width: 1px; }',
    '.a { border-left-width: 0; }',
    '.a { border-left-color: var(--sr-edge); }',
    '.a { border-left-color: currentColor; }',
    '.a { border-inline-start: 1px solid var(--sr-edge); }',
    // a ring on all sides, or a shadow that is not an inset left bar
    '.a { box-shadow: inset 0 0 0 1px red; }',
    '.a { box-shadow: inset 0 0 0 2px var(--c), 0 8px 24px rgb(0 0 0 / 0.4); }',
    '.a { box-shadow: 4px 0 0 red; }',
    '.a { box-shadow: inset 0 4px 0 red; }',
    '.a { box-shadow: inset -4px 0 0 red; }',
    '.a { box-shadow: var(--an-shadow); }',
    '.a { box-shadow: none; }',
    // a ::before or ::after that is not a stripe on the left edge
    '.a::before { position: absolute; right: 0; width: 3px; background: red; }',
    '.a::before { position: absolute; left: 8px; width: 3px; background: red; }',
    '.a::before { position: absolute; left: 0; width: 12px; background: red; }',
    // the loading spinner's shape, and any 4px x 4px dot at left: 0
    '.a::before { content: \'\'; position: absolute; top: 0; left: 0; width: 4px; height: 4px; border-radius: 50%; background-color: rgba(255, 255, 255, 0.92); }',
    '.a::after { position: absolute; left: 0; width: 4px; height: 4px; background: red; }',
    '.a::after { position: absolute; left: 0; top: 0; width: 4px; height: 3px; background: red; }',
    '.a::before { position: absolute; left: 0; width: 3px; background: transparent; }',
    '.a::before { position: absolute; left: 0; width: 3px; background: none; }',
    '.a::before { position: absolute; left: 0; width: 3px; }',
    '.a::before { position: relative; left: 0; width: 3px; background: red; }',
    '.a::before { position: absolute; left: 0; background: red; }',
    '.a { position: absolute; left: 0; width: 3px; background: red; }',
    // (a) a 1px neutral stripe is a tree's guide line; not at the left, not painted, not tall, an overlay
    '.a { position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: var(--sr-edge); }',
    '.a { position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: #333; }',
    '.a { position: absolute; left: -1px; top: 0; height: 100%; width: 1px; background-color: rgb(255 255 255 / 0.12); }',
    '.a { position: absolute; left: 8px; top: 0; bottom: 0; width: 3px; background: red; }',
    '.a { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: transparent; }',
    '.a { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; }',
    '.a { position: absolute; inset: 0; background: red; }',
    '.a { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: red; }',
    '.a { position: absolute; left: 0; top: 0; width: 3px; height: 3px; background: red; }',
    '.a { position: relative; left: 0; top: 0; bottom: 0; width: 3px; background: red; }',
    // (b) a width the check can read
    '.a { border-left: calc(0.5px + 0.5px) solid #444; }',
    '.a { border-left: thin solid #444; }',
    '.a { border-left: red; }',
    '.a { border-inline-start: thin solid var(--sr-edge); }',
    // (c) lists that are a frame or neutral, a 2- or 3-value list (left is the right), no left border
    '.a { border-width: 2px; }',
    '.a { border-width: 0 3px; }',
    '.a { border-width: 0 3px 0; }',
    '.a { border-width: 0 0 2px; }',
    '.a { border-width: 1px 1px 1px 1px; }',
    '.a { border-width: 0 0 0 1px; }',
    '.a { border-width: 0 0 0 3px; border-style: none; }',
    '.a { border-width: 0 0 0 3px; border-style: none none none none; }',
    '.a { border-color: red; }',
    '.a { border-color: red blue; }',
    '.a { border-color: red blue green; }',
    '.a { border-color: #444 #444 #444 #333; }',
    '.a { border-color: red red red transparent; }',
    '.a { border-color: red red red blue; border-width: 0; }',
    '.a { border-color: var(--sr-accent); }',
    // (d) var() with only neutral definitions, a literal fallback when undefined
    '.a { border-left: var(--hair) solid #444; }',
    '.a { border-left: 1px solid var(--nope, #333); }',
    '.a { border-left: 1px solid var(--sr-edge); }',
    '.a { border-left-color: var(--sr-ink-light); }',
    // neutral by chroma: a muted green-grey, a var defined only as one, a white at low alpha
    '.a { border-left: 1px solid #536047; }',
    '.a { border-left: 1px solid var(--olive-edge); }',
    '.a { border-left: 1px solid rgb(255 255 255 / 0.06); }',
    // (e) a 1px neutral inset, a soft inset, a ring, an unresolved colour, a small outer shadow
    '.a { box-shadow: inset 1px 0 0 var(--sr-edge); }',
    '.a { box-shadow: inset 1px 0 0 #444; }',
    '.a { box-shadow: inset calc(0.5px + 0.5px) 0 0 #444; }',
    '.a { box-shadow: inset var(--hair) 0 0 #444; }',
    '.a { box-shadow: inset 4px 0 8px red; }',
    '.a { box-shadow: inset 4px 0 5px red; }',
    '.a { box-shadow: 0 0 0 1px var(--agent-color); }',
    '.a { box-shadow: -1px 0 0 #444; }',
    '.a { box-shadow: -4px 0 6px red; }',
    '.a { box-shadow: -4px 4px 0 red; }',
    '.a { box-shadow: 2px 0 0 red; }',
    // (g) a url with a semicolon in a string, and a braceless body
    '.a { background: url("data:image/svg+xml;base64,AAA"); border-left: 1px solid #444; }',
  ];
  it.each(fine)('%s', (css) => {
    expect(found(css)).toEqual([]);
  });

  // (f) an allowed entry is the file, the selector, the property and the value
  it.each(ALLOWED as Array<{ file: string; selector: string; decl: string; why: string }>)('the allowed shape $selector { $decl }', ({ file, selector, decl }) => {
    const css = `${selector} { ${decl}; }`;
    expect(findLeftEdges(css, file, VARS).length).toBeGreaterThan(0);
    expect(found(css, file)).toEqual([]);
    // Only in that file: the same selector elsewhere is not allowed.
    expect(found(css, 'styles/elsewhere.css')).not.toEqual([]);
    // A new declaration on the allowed selector is not exempt: another bar, another value, another property.
    expect(found(`${selector} { ${decl}; box-shadow: inset 3px 0 0 red; }`, file)).toHaveLength(1);
    expect(found(`${selector} { ${decl}; border-left-color: red; }`, file)).toHaveLength(1);
    expect(found(`${selector} { ${decl}; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: red; }`, file)).toHaveLength(1);
    expect(found(`${selector} { ${decl.replace(/\d+px/, '9px')}; }`, file)).toHaveLength(1);
  });

  it('an allowed entry is exact: another selector in the same file is not allowed', () => {
    const [entry] = ALLOWED as Array<{ file: string; selector: string; decl: string }>;
    expect(found(`${entry.selector}-more { ${entry.decl}; }`, entry.file)).toHaveLength(1);
    expect(found(`${entry.selector}, .other { ${entry.decl}; }`, entry.file)).toHaveLength(1);
  });

  it('an allowed entry no rule matches is reported stale', () => {
    const hits = ALLOWED.flatMap((entry: { file: string; selector: string; decl: string }) => findLeftEdges(`${entry.selector} { ${entry.decl}; }`, entry.file, VARS));
    expect(staleAllowed(hits)).toEqual([]);
    expect(staleAllowed(hits.slice(1))).toHaveLength(1);
    expect(staleAllowed([])).toHaveLength(ALLOWED.length);
  });

  it('names a reason for every allowed shape', () => {
    for (const entry of ALLOWED as Array<{ why: string }>) expect(entry.why.length).toBeGreaterThan(10);
  });
});

describe('a neutral edge colour', () => {
  it.each(['transparent', 'currentColor', 'none', '#444', '#444444', '#fff', 'rgb(255 255 255 / 0.12)', 'rgba(255, 255, 255, 0.12)', 'hsl(0 0% 40%)',
    'var(--sr-edge)', 'var(--sr-edge-strong)', 'var(--sr-edge-strong, #444)', 'var(--sr-ink-light)', 'var(--an-edge)', 'var(--nope, #444)',
    '#536047', 'var(--olive-edge)', 'rgb(255 255 255 / 0.06)', 'white', 'black', 'rgb(0 0 0 / 0.5)', 'inherit', 'color-mix(in srgb, #444 30%, transparent)', 'color-mix(in srgb, var(--sr-edge) 50%, white)'])('%s is neutral', (color) => {
    expect(isNeutralColor(color, VARS)).toBe(true);
  });
  it.each(['red', '#5b9dff', 'rgb(91 157 255)', 'rgb(255 0 0 / 0.5)', 'hsl(20 90% 50%)', 'var(--agent-color)', 'var(--sr-accent)', 'var(--chat-accent)',
    'var(--an-author)', 'var(--pin-color)', 'var(--sr-edge-accent)', 'var(--x)', 'var(--nope, red)', 'color-mix(in srgb, red 50%, transparent)', 'color-mix(in srgb, var(--agent-color) 30%, transparent)', 'color-mix(in srgb, #444 50%, #5b9dff)', 'hsl(215 100% 68%)', '#e8a33d', '#ff5a1f',
    // every definition counts, and a name never decides
    'var(--tint-edge)', 'var(--hairline-edge)', 'var(--alias)'])('%s is not', (color) => {
    expect(isNeutralColor(color, VARS)).toBe(false);
  });
});

// (h) inline styles
describe('the inline-style check fails on a left edge, static or computed', () => {
  const jsx = (style: string) => `export const A = () => <div style={{ ${style} }} />;`;
  const edges = (style: string) => scanSource(jsx(style), 'components/A.tsx').edges.length;
  it.each([
    "borderLeft: '3px solid red'",
    'borderLeft: `3px solid ${agent.color}`',
    'borderLeft: `1px solid ${agent.color}`',
    'borderLeftColor: agent.color',
    'borderLeftWidth: 0',
    "borderInlineStart: '1px solid #444'",
    'borderInlineStartColor: color',
    "'border-left': '3px solid red'",
    "boxShadow: 'inset 3px 0 0 red'",
    'boxShadow: `inset 3px 0 0 ${agent.color}`',
    "boxShadow: active ? 'inset 3px 0 0 red' : 'none'",
    "boxShadow: ['inset', '3px 0 0', color].join(' ')",
    'boxShadow: `0 0 0 1px ${c}, INSET 4px 0 0 ${c}`',
    'borderLeft',
  ])('%s', (style) => {
    expect(edges(style)).toBe(1);
  });
  it.each([
    "boxShadow: '0 1px 2px rgb(0 0 0 / 0.3)'",
    'boxShadow: `0 0 0 1px ${agent.color}`',
    'boxShadow: shadow',
    'borderBottom: `1px solid ${agent.color}`',
    'borderRadius: 4',
    'width: pct',
    "borderRight: '1px solid red'",
  ])('and passes %s', (style) => {
    expect(edges(style)).toBe(0);
  });
  it('still reads static visual styles', () => {
    expect(scanSource(jsx("color: 'red'"), 'components/A.tsx').staticStyles).toHaveLength(1);
    expect(scanSource(jsx('color: c'), 'components/A.tsx').staticStyles).toHaveLength(0);
    expect(scanSource(jsx("borderLeft: '3px solid red'"), 'components/A.tsx').staticStyles).toHaveLength(0);
  });
});
