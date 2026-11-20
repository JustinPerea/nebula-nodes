// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ALLOWED, findLeftEdges, isAllowed, isNeutralColor } from '../scripts/check-left-edge.mjs';

/**
 * scripts/check-left-edge.mjs runs in `npm run lint`: no stylesheet paints an accent edge down
 * the left side of a block (design). Each fixture is one rule; `bars` must be caught, `fine`
 * must pass.
 */

type Hit = { file: string; selector: string };
const found = (css: string, file = 'styles/x.css') => (findLeftEdges(css, file) as Hit[]).filter((hit) => !isAllowed(hit));

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
  ];
  it.each(bars)('%s', (css) => {
    expect(found(css)).toHaveLength(1);
  });

  it('a rule inside @media, with its line number', () => {
    const hits = findLeftEdges('/* c */\n@media (min-width: 1px) {\n  .a {\n    border-left: 4px solid red;\n  }\n}\n', 'styles/x.css') as Array<Hit & { line: number }>;
    expect(hits.map((hit) => [hit.selector, hit.line])).toEqual([['.a', 4]]);
  });

  it('a bar written inside a comment is not read, and a brace in a comment does not hide the next rule', () => {
    expect(found('/* .a { border-left: 3px solid red; } */ .b { border-left: 3px solid red; }').map((hit) => hit.selector)).toEqual(['.b']);
    expect(found('/* } { */ .b { box-shadow: inset 4px 0 0 red; }').map((hit) => hit.selector)).toEqual(['.b']);
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
  ];
  it.each(fine)('%s', (css) => {
    expect(found(css)).toEqual([]);
  });

  it.each(ALLOWED as Array<{ file: string; selector: string; why: string }>)('the allowed shape $selector', ({ file, selector }) => {
    const css = `${selector} { position: absolute; left: 0; width: 2px; background: red; border-left: 2px solid red; border-left-width: 4px; }`;
    expect(findLeftEdges(css, file).length).toBeGreaterThan(0);
    expect(found(css, file)).toEqual([]);
    // Only in that file: the same selector elsewhere is not allowed.
    expect(found(css, 'styles/elsewhere.css')).not.toEqual([]);
  });

  it('an allowed entry is exact: another selector in the same file is not allowed', () => {
    const [entry] = ALLOWED as Array<{ file: string; selector: string }>;
    expect(found(`${entry.selector}-more { border-left: 3px solid red; }`, entry.file)).toHaveLength(1);
    expect(found(`${entry.selector}, .other { border-left: 3px solid red; }`, entry.file)).toHaveLength(1);
  });

  it('names a reason for every allowed shape', () => {
    for (const entry of ALLOWED as Array<{ why: string }>) expect(entry.why.length).toBeGreaterThan(10);
  });
});

describe('a neutral edge colour', () => {
  it.each(['transparent', 'currentColor', 'none', '#444', '#444444', '#fff', 'rgb(255 255 255 / 0.12)', 'rgba(255, 255, 255, 0.12)', 'hsl(0 0% 40%)',
    'var(--sr-edge)', 'var(--sr-edge-strong)', 'var(--sr-edge-strong, #444)', 'var(--sr-ink-light)', 'var(--an-edge)'])('%s is neutral', (color) => {
    expect(isNeutralColor(color)).toBe(true);
  });
  it.each(['red', '#5b9dff', 'rgb(91 157 255)', 'rgb(255 0 0 / 0.5)', 'hsl(20 90% 50%)', 'var(--agent-color)', 'var(--sr-accent)', 'var(--chat-accent)',
    'var(--an-author)', 'var(--pin-color)', 'var(--sr-edge-accent)', 'var(--x)', 'var(--sr-edge, red)', 'color-mix(in srgb, red 50%, transparent)'])('%s is not', (color) => {
    expect(isNeutralColor(color)).toBe(false);
  });
});
