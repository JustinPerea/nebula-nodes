// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ICON_ONLY, isDisabledScoped, isDimLiteral, scan } from '../scripts/check-text-ink.mjs';

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
    'rgba(255, 255, 255, 0.3)',
    'rgba(255,255,255,.30)',
    'rgb(255 255 255 / 0.35)',
    'rgba(255, 255, 255, 0.45)',
    'rgb(255 255 255 / 45%)',
    'rgba(255, 255, 255, 0.5)',
    'rgb(255 255 255 / 50%)',
    'rgba(255, 255, 255, 0.54)',
    'hsla(0, 0%, 100%, 0.5)',
    '#ffffff80',
    '#fff8',
    '#ffffff8c',
    '#FFFFFF4D',
  ])('fails %s', (literal) => {
    expect(isDimLiteral(literal)).toBe(true);
    expect(css(`.a { color: ${literal}; }`, '')).toHaveLength(1);
  });

  it.each(['rgba(0, 0, 0, 0.4)', 'rgba(0, 0, 0, 0.5)', '#ffffff', '#ffffff99', 'hsla(0, 0%, 100%, 0.55)', 'red'])('passes %s', (literal) => {
    expect(isDimLiteral(literal)).toBe(false);
    expect(css(`.a { color: ${literal}; }`, '')).toEqual([]);
  });
});

describe('check-text-ink: the dim range', () => {
  it('fails a token at .35 used through an alias', () => {
    const defs = ':root { --faded: rgba(255, 255, 255, 0.35); }\n.t { --one: var(--faded); }\n';
    expect(css('.a { color: var(--faded); }', defs)).toHaveLength(1);
    expect(css('.a { color: var(--one); }', defs)).toHaveLength(1);
  });

  it('passes a token at .20 and one at .55, and a dim literal on a non-text property', () => {
    expect(css('.a { color: var(--faint); }', ':root { --faint: rgba(255, 255, 255, 0.2); }\n')).toEqual([]);
    expect(css('.a { color: var(--light); }', ':root { --light: rgba(255, 255, 255, 0.55); }\n')).toEqual([]);
    expect(css('.a { border-color: rgba(255, 255, 255, 0.45); }', '')).toEqual([]);
  });

  it('exempts a disabled-scoped .45 and an icon-only control at .5', () => {
    expect(css('.a:disabled { color: rgba(255, 255, 255, 0.45); }', '')).toEqual([]);
    expect(css('body.app-slava-restraint .project-home__rename { color: rgb(255 255 255 / 0.5); }', '')).toEqual([]);
  });

  it('fails a dim fallback of an undefined variable', () => {
    expect(css('.a { color: var(--nowhere, rgb(255 255 255 / 0.45)); }', '')).toHaveLength(1);
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

  it('does not read a quoted paren as a paren (a quoted ) cannot close :is())', () => {
    expect(isDisabledScoped(".a:is([title=')'], :disabled)")).toBe(false);
    expect(isDisabledScoped(".a:is([title='('], :disabled)")).toBe(false);
    expect(isDisabledScoped('.a:is([title=")"], :disabled)')).toBe(false);
    const found = css("[title='(']:disabled, .x { color: var(--sr-ink-meta); }");
    expect(found).toHaveLength(1);
    expect(found[0].selector).toBe('.x');
    expect(css("[title=')']:disabled, .x { color: var(--sr-ink-meta); }")).toHaveLength(1);
  });

  it('does not count a disabled state named inside a quoted value, or a longer pseudo name', () => {
    expect(isDisabledScoped("[title=':disabled']")).toBe(false);
    expect(isDisabledScoped("[title='[disabled]']")).toBe(false);
    expect(isDisabledScoped('.a:disabled-x')).toBe(false);
    expect(isDisabledScoped('.a:disabled')).toBe(true);
    expect(isDisabledScoped(".a[title='x y']:disabled")).toBe(true);
    expect(css("[title=':disabled'] { color: var(--sr-ink-meta); }")).toHaveLength(1);
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

describe('check-text-ink: inline TSX, read as a syntax tree', () => {
  const dim = "{ color: 'var(--sr-ink-meta)' }";

  it.each([
    ['after a URL regex on the same line', `const re = /^https?:\\/\\//; const s = ${dim};`],
    ['after a regex holding /* with the colour on the next line', `const re = /src\\/*.ts/;\nconst s = ${dim};`],
    ['after a regex class holding /*', `const re = /[/*]/; const s = ${dim};`],
    ['after a nested template holding //', "const t = `${ok ? `a//b` : ''}`; const s = { color: 'var(--sr-ink-meta)' };"],
    ['after JSX text holding http://', `const a = <div><p>see http://x</p><b style={${dim}} /></div>;`],
    ['as a quoted key', "const s = { 'color': 'var(--sr-ink-meta)' };"],
    ['as a quoted CSS key', "const s = { '-webkit-text-fill-color': 'var(--sr-ink-meta)' };"],
    ['as a caret colour', "const s = { caretColor: 'rgba(255,255,255,.45)' };"],
    ['as a no-substitution template', 'const s = { color: `var(--sr-ink-meta)` };'],
    ['through a cast', "const s = { color: 'var(--sr-ink-meta)' as const };"],
    ['at .5', "const s = { color: 'rgb(255 255 255 / 0.5)' };"],
  ])('fails a dim colour %s', (_name, source) => {
    expect(tsx(source)).toHaveLength(1);
  });

  it('reports the line of the property', () => {
    const found = tsx("const a = 1;\nconst b = 2;\nconst s = {\n  color: 'var(--sr-ink-meta)',\n};");
    expect(found.map((hit) => hit.line)).toEqual([4]);
  });

  it('passes the light ink, .20, a template with a substitution and a non-text key', () => {
    expect(tsx("const s = { color: 'var(--sr-ink-light)' };")).toEqual([]);
    expect(tsx("const s = { color: 'rgba(255,255,255,.2)' };")).toEqual([]);
    expect(tsx('const s = { color: `rgba(255,255,255,${a})` };')).toEqual([]);
    expect(tsx("const s = { borderColor: 'var(--sr-ink-meta)', backgroundColor: 'rgba(255,255,255,.45)' };")).toEqual([]);
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
