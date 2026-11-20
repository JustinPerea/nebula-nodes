// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ICON_ONLY, isDisabledScoped, isMetaLiteral, scan } from '../scripts/check-text-ink.mjs';

/**
 * scripts/check-text-ink.mjs runs in `npm run lint` (design: text takes the light ink; meta ink is
 * for non-text, disabled controls and the named icon-only controls). Each bad fixture must report;
 * each fine one must not.
 */
const META = ':root { --sr-ink-meta: rgba(255, 255, 255, 0.40); }\n';
const css = (rules: string, defs = META) => scan([{ file: 'fixture.css', source: defs + rules }], []);
const tsx = (source: string) => scan([{ file: 'fixture.css', source: META }], [{ file: 'Fixture.tsx', source }]);

describe('check-text-ink: text properties', () => {
  it.each([
    ['color', '.a { color: var(--sr-ink-meta); }'],
    ['-webkit-text-fill-color', '.a { -webkit-text-fill-color: var(--sr-ink-meta); }'],
    ['caret-color', '.a { caret-color: var(--sr-ink-meta); }'],
    ['a ::placeholder rule', '.a::placeholder { color: var(--sr-ink-meta); }'],
    ['fill on svg text', 'svg text { fill: var(--sr-ink-meta); }'],
    ['fill on tspan', '.chart tspan { fill: var(--sr-ink-meta); }'],
    ['the prefixed twin', 'body.app-slava-restraint .a { color: var(--sr-ink-meta); }'],
    ['the var() fallback form', '.a { color: var(--sr-ink-meta, rgba(255, 255, 255, 0.4)); }'],
    ['!important', '.a { color: var(--sr-ink-meta) !important; }'],
    ['-webkit-text-stroke-color', '.a { -webkit-text-stroke-color: var(--sr-ink-meta); }'],
  ])('fails %s', (_name, rules) => {
    const found = css(rules);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBeGreaterThan(0);
  });

  it('passes non-text properties that read meta ink', () => {
    expect(css('.a { border-color: var(--sr-ink-meta); background: var(--sr-ink-meta); stroke: var(--sr-ink-meta); box-shadow: 0 0 0 1px var(--sr-ink-meta); text-decoration-color: var(--sr-ink-meta); outline-color: var(--sr-ink-meta); }')).toEqual([]);
  });

  it('passes fill on a non-text svg selector, and text on the light ink', () => {
    expect(css('.dot { fill: var(--sr-ink-meta); }')).toEqual([]);
    expect(css('.a { color: var(--sr-ink-light); }', ':root { --sr-ink-light: rgba(255, 255, 255, 0.55); }')).toEqual([]);
  });
});

describe('check-text-ink: aliases', () => {
  it('follows one hop', () => {
    expect(css('.a { color: var(--one); }', `${META}.t { --one: var(--sr-ink-meta); }\n`)).toHaveLength(1);
  });

  it('follows two hops', () => {
    const defs = `${META}.t { --one: var(--sr-ink-meta); }\n.u { --two: var(--one); }\n`;
    expect(css('.a { color: var(--two); }', defs)).toHaveLength(1);
  });

  it('follows an alias defined as a literal, and one with a meta fallback', () => {
    expect(css('.a { color: var(--lit); }', '.t { --lit: #ffffff66; }\n')).toHaveLength(1);
    expect(css('.a { color: var(--one); }', `${META}.t { --one: var(--nowhere, var(--sr-ink-meta)); }\n`)).toHaveLength(1);
  });

  it('passes an alias of the light ink, and a variable defined elsewhere with a meta fallback', () => {
    expect(css('.a { color: var(--one); }', ':root { --sr-ink-light: rgba(255, 255, 255, 0.55); }\n.t { --one: var(--sr-ink-light); }\n')).toEqual([]);
    expect(css('.a { color: var(--defined, rgba(255, 255, 255, 0.4)); }', '.t { --defined: red; }\n')).toEqual([]);
  });

  it('passes an alias that only a non-text property reads', () => {
    expect(css('.a { background: var(--one); }', `${META}.t { --one: var(--sr-ink-meta); }\n`)).toEqual([]);
  });
});

describe('check-text-ink: literals', () => {
  it.each([
    'rgba(255,255,255,.4)',
    'rgba(255, 255, 255, .40)',
    'rgba(255, 255, 255, 0.4)',
    'rgb(255 255 255 / 40%)',
    'rgb(255 255 255 / 0.4)',
    '#ffffff66',
    '#FFF6',
    'hsla(0, 0%, 100%, 0.4)',
    'hsl(0 0% 100% / 40%)',
  ])('fails %s', (literal) => {
    expect(isMetaLiteral(literal)).toBe(true);
    expect(css(`.a { color: ${literal}; }`, '')).toHaveLength(1);
  });

  it.each(['rgba(255, 255, 255, 0.55)', 'rgba(0, 0, 0, 0.4)', 'rgba(255, 255, 255, 0.45)', '#ffffff', '#ffffff99', 'hsla(0, 0%, 100%, 0.55)', 'red'])('passes %s', (literal) => {
    expect(isMetaLiteral(literal)).toBe(false);
    expect(css(`.a { color: ${literal}; }`, '')).toEqual([]);
  });
});

describe('check-text-ink: disabled controls', () => {
  it.each([
    '.a:disabled { color: var(--sr-ink-meta); }',
    'button[disabled] { color: var(--sr-ink-meta); }',
    '.a[aria-disabled="true"] { color: var(--sr-ink-meta); }',
    ".a[aria-disabled='true'] { color: var(--sr-ink-meta); }",
    '.a[aria-disabled=true]::placeholder { color: var(--sr-ink-meta); }',
    '.a:disabled, .b[disabled] { color: var(--sr-ink-meta); }',
    ":is(:disabled, [aria-disabled='true']) { color: var(--sr-ink-meta); }",
    ".message-box__field[aria-disabled='true'] ~ .message-box__key { color: var(--sr-ink-meta); }",
  ])('passes a disabled-scoped rule: %s', (rules) => {
    expect(css(rules)).toEqual([]);
  });

  it('fails a comma list where only one part is disabled', () => {
    const found = css('.a:disabled, .b { color: var(--sr-ink-meta); }');
    expect(found).toHaveLength(1);
    expect(found[0].selector).toBe('.b');
  });

  it.each([
    '.a:is(:disabled, :hover) { color: var(--sr-ink-meta); }',
    '.a:where(:disabled, .x) { color: var(--sr-ink-meta); }',
    '.row:has(:disabled) .label { color: var(--sr-ink-meta); }',
    '.a:disabled .b { color: var(--sr-ink-meta); }',
    '.f:disabled ~ .label { color: var(--sr-ink-meta); }',
    ".field[aria-disabled='true'] ~ .key { color: var(--sr-ink-meta); }",
  ])('fails a selector that is not disabled-only: %s', (rules) => {
    expect(css(rules)).toHaveLength(1);
  });

  it('does not count :not(:disabled) or an aria-disabled false as disabled', () => {
    expect(isDisabledScoped('.a:not(:disabled)')).toBe(false);
    expect(isDisabledScoped('.a[aria-disabled="false"]')).toBe(false);
    expect(css('.a:not(:disabled) { color: var(--sr-ink-meta); }')).toHaveLength(1);
  });
});

describe('check-text-ink: icon-only controls', () => {
  it('lists the loop toggle, which renders only an icon', () => {
    expect(ICON_ONLY.has('.model-node__loop-toggle')).toBe(true);
  });

  it('passes the named icon-only controls, with or without the body prefix and inside :is()', () => {
    expect(ICON_ONLY.has('.project-home__rename')).toBe(true);
    expect(css('body.app-slava-restraint .project-home__rename { color: var(--sr-ink-meta); }')).toEqual([]);
    expect(css('.project-home__search svg { color: var(--sr-ink-meta); }')).toEqual([]);
    expect(css('body.app-slava-restraint :is(.panel__header-action, .model-node__header-action) { color: var(--sr-ink-meta); }')).toEqual([]);
  });

  it('matches the exact selector: a text rule on the same class still fails', () => {
    expect(css('.project-home__search input::placeholder { color: var(--sr-ink-meta); }')).toHaveLength(1);
    expect(css('.project-home__rename-label { color: var(--sr-ink-meta); }')).toHaveLength(1);
  });

  it('fails an icon in a list shared with a text selector, naming only the text part', () => {
    const found = css('.chat__tool-icon, .chat__tool-status { color: var(--sr-ink-meta); }');
    expect(found).toHaveLength(1);
    expect(found[0].selector).toBe('.chat__tool-status');
  });
});

describe('check-text-ink: inline TSX', () => {
  it('fails a style color that is meta ink, as a var, an alias or a literal', () => {
    expect(tsx("<span style={{ color: 'var(--sr-ink-meta)' }} />")).toHaveLength(1);
    expect(tsx('<span style={{ margin: 0, color: "rgba(255, 255, 255, 0.4)" }} />')).toHaveLength(1);
    expect(tsx("const style = { color: 'var(--sr-ink-meta, #888)' };")).toHaveLength(1);
  });

  it('passes the light ink, and a shape colour that is not a text colour', () => {
    expect(tsx("<span style={{ color: 'var(--sr-ink-light)' }} />")).toEqual([]);
    expect(tsx("const o = { waveColor: 'rgba(255, 255, 255, 0.40)' };")).toEqual([]);
  });
});

describe('check-text-ink: comments', () => {
  it('ignores meta ink named in a TSX comment, and still reads a string with // in it', () => {
    expect(tsx("// color: 'var(--sr-ink-meta)' is retired\nconst a = 1;")).toEqual([]);
    expect(tsx("/* style={{ color: 'var(--sr-ink-meta)' }} */\nconst a = 1;")).toEqual([]);
    expect(tsx("const u = 'https://x.test'; const s = { color: 'var(--sr-ink-meta)' };")).toHaveLength(1);
  });

  it('ignores a commented-out rule', () => {
    expect(css('/* .a { color: var(--sr-ink-meta); } */\n.b { color: var(--sr-ink-light); }')).toEqual([]);
  });
});
