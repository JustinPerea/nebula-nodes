// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { computeLineStarts, lineForOffset, parseDeclarations } from '../scripts/lib/css-scan.mjs';
import {
  collectAppSheets,
  collectAppSources,
  findBaseRuleFaults,
  findBaseRuleShadows,
  findFontTokenHits,
  findInlineFonts,
  findSystemFonts,
  findUndefinedFontTokens,
  firstFamilyOf,
  firstFamilyVarOf,
  hasBaseRule,
  INLINE_EXCEPTIONS,
  scan,
} from '../scripts/check-system-fonts.mjs';

/**
 * scripts/check-system-fonts.mjs runs in `npm run lint` (design: one face everywhere, the app face;
 * and the base rule that puts it, at the control size, on every button and field). Each bad fixture
 * must report; each fine one must not.
 */
const BASE = ':where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control); }\n';
const sheet = (source: string, file = 'fixture.css') => [{ file, source }];
const app = (source: string) => sheet(source, 'App.css');
const hits = (rules: string) => findSystemFonts(sheet(rules));

describe('check-system-fonts: first families outside the allowlist', () => {
  it.each([
    ['-apple-system', ".a { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }"],
    ['BlinkMacSystemFont', '.a { font-family: BlinkMacSystemFont, sans-serif; }'],
    ['system-ui', '.a { font-family: system-ui, sans-serif; }'],
    ['ui-sans-serif', '.a { font-family: ui-sans-serif, sans-serif; }'],
    ['a quoted Segoe UI', ".a { font-family: 'Segoe UI', Tahoma, sans-serif; }"],
    ['Arial', '.a { font-family: Arial, sans-serif; }'],
    ['Helvetica', '.a { font-family: Helvetica, Arial, sans-serif; }'],
    ['Helvetica Neue first', ".a { font-family: 'Helvetica Neue', Arial; }"],
    ['a bare sans-serif', '.a { font-family: sans-serif; }'],
    ['a bare serif', '.a { font-family: serif; }'],
    ['Georgia', '.a { font-family: Georgia, serif; }'],
    ['a quoted Times New Roman', ".a { font-family: 'Times New Roman'; }"],
    ['Roboto', '.a { font-family: Roboto; }'],
    ['SF Pro Text', ".a { font-family: 'SF Pro Text', sans-serif; }"],
    ['a bare monospace', '.a { font-family: monospace; }'],
    ['ui-monospace', '.a { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }'],
    ['an SF Mono first', ".a { font-family: 'SF Mono', Menlo, monospace; }"],
    ['uppercase and !important', '.a { font-family: ARIAL !important; }'],
    ['the prefixed twin', 'body.app-slava-restraint .a { font-family: system-ui; }'],
    ['inside an @media block', '@media (min-width: 1px) { .a { font-family: system-ui, sans-serif; } }'],
    ['inside an @layer block', '@layer base { .a { font-family: Roboto; } }'],
    ['the font shorthand', '.a { font: 600 12px/1.4 -apple-system, sans-serif; }'],
    ['the shorthand with a keyword size', '.a { font: bold small Arial, sans-serif; }'],
    ['the shorthand with a token line height', '.a { font: 500 12px/var(--lh, 1.4) system-ui, sans-serif; }'],
    ['the shorthand with a token size', '.a { font: 500 var(--size, 12px) system-ui, sans-serif; }'],
    ['the shorthand with a clamp() size', '.a { font: clamp(11px, 1vw, 13px) system-ui; }'],
    ['the shorthand with a calc() size', '.a { font: calc(1px + 10px) system-ui; }'],
    ['the shorthand with a min() size and a calc() line height', '.a { font: min(12px, 1vw)/calc(1em + 2px) Georgia; }'],
    ['the shorthand with a max() size', '.a { font: 600 max(11px, 1vw) Roboto; }'],
    ['the shorthand with a bare 0 size', '.a { font: 0 system-ui; }'],
    ['the shorthand with a nested calc(clamp())', '.a { font: calc(clamp(1px, 2px, 3px) + 1px) Arial; }'],
    ['font: caption', '.a { font: caption; }'],
    ['font: icon', '.a { font: icon; }'],
    ['font: menu', '.a { font: menu; }'],
    ['font: message-box', '.a { font: message-box; }'],
    ['font: small-caption', '.a { font: small-caption; }'],
    ['font: status-bar', '.a { font: status-bar !important; }'],
    ['font: -webkit-small-control', '.a { font: -webkit-small-control; }'],
    ['font: -apple-system-body', '.a { font: -apple-system-body; }'],
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

  it('names var(--sr-ui) and var(--sr-mono) in its message', async () => {
    const { FAILURE_MESSAGE } = await import('../scripts/check-system-fonts.mjs');
    expect(FAILURE_MESSAGE).toContain('var(--sr-ui)');
    expect(FAILURE_MESSAGE).toContain('var(--sr-mono)');
  });
});

describe('check-system-fonts: what passes', () => {
  it.each([
    ['a var() with a system fallback', ".a { font-family: var(--sr-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); }"],
    ['a var() with a bare fallback', '.a { font-family: var(--sr-ui, sans-serif); }'],
    ['a plain var()', '.a { font-family: var(--sr-ui); }'],
    ['the mono token', '.a { font-family: var(--sr-mono); }'],
    ['the shorthand with a var() family', '.a { font: 600 11px/14px var(--sr-font-sans, system-ui, sans-serif); }'],
    ['the shorthand with a var() family and a token size', '.a { font: 500 var(--size, 12px)/1 var(--sr-ui, system-ui); }'],
    ['the shorthand with a clamp() size and a var() family', '.a { font: clamp(11px, 1vw, 13px) var(--sr-ui); }'],
    ['inherit', '.a { font-family: inherit; }'],
    ['initial', '.a { font-family: initial; }'],
    ['unset', '.a { font-family: unset; }'],
    ['revert', '.a { font-family: revert; }'],
    ['revert-layer', '.a { font-family: revert-layer; }'],
    ['the shorthand inherit', '.a { font: inherit; }'],
    ['a shorthand with no family', '.a { font: 12px/1.4; }'],
    ['the named app face', ".a { font-family: 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif; }"],
    ['the app face, bare and upper case', '.a { font-family: INTER, sans-serif; }'],
    ['the app mono, quoted', ".a { font-family: 'JetBrains Mono', monospace; }"],
    ['the app mono, bare', '.a { font-family: JetBrains Mono, monospace; }'],
    ['the shorthand with the app face', ".a { font: 600 12px/1.4 'Inter', sans-serif; }"],
  ])('%s', (_name, rules) => {
    expect(hits(rules)).toEqual([]);
  });

  it('does not let a face that only contains an allowed name through', () => {
    expect(hits(".a { font-family: 'Inter Display', sans-serif; }")).toHaveLength(1);
  });

  it('does not read comments or other properties', () => {
    expect(hits('/* font-family: Arial; */ .a { color: red; }')).toEqual([]);
    expect(hits('.a { content: "font-family: Arial"; font-size: 12px; }')).toEqual([]);
  });

  it('reads the first family of each form', () => {
    expect(firstFamilyOf('font-family', "'Segoe UI', sans-serif")).toBe('segoe ui');
    expect(firstFamilyOf('font', '600 12px/1.4 Arial, sans-serif')).toBe('arial');
    expect(firstFamilyOf('font', 'clamp(11px, 1vw, 13px) system-ui')).toBe('system-ui');
    expect(firstFamilyOf('font', '0 system-ui')).toBe('system-ui');
    expect(firstFamilyOf('font', 'menu')).toBe('menu');
    expect(firstFamilyOf('font', '12px var(--x, Arial)')).toBeNull();
    expect(firstFamilyOf('font-family', 'inherit')).toBeNull();
  });
});

describe('check-system-fonts: custom properties used as a font family', () => {
  const tokens = (...sheets: string[]) => findFontTokenHits(sheets.map((source, i) => ({ file: `f${i}.css`, source })));

  it('fails a token that holds a system stack and is used as font-family', () => {
    const found = tokens(':root { --notice-font: -apple-system, sans-serif; } .a { font-family: var(--notice-font); }');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ prop: '--notice-font', line: 1, face: '-apple-system' });
  });

  it('fails when the token is used in the font shorthand, or defined in another sheet', () => {
    expect(tokens(':root { --t: Georgia, serif; }', '.a { font: 12px/1.4 var(--t); }')).toHaveLength(1);
  });

  it('fails a token reached through another token', () => {
    const found = tokens(':root { --inner: Roboto; --outer: var(--inner); } .a { font-family: var(--outer); }');
    expect(found.map((hit) => hit.prop)).toEqual(['--inner']);
  });

  it('passes tokens led by var(), an allowed face or a keyword', () => {
    expect(tokens(":root { --a: var(--sr-ui); --b: 'Inter', sans-serif; --c: inherit; --d: 'JetBrains Mono', monospace; } .a { font-family: var(--a); } .b { font-family: var(--b); } .c { font-family: var(--c); } .d { font-family: var(--d); }")).toEqual([]);
    expect(tokens(':root { --a: var(--sr-ui, Arial); } .a { font-family: var(--a); }')).toEqual([]);
  });

  it('ignores a custom property that is never used as a font family', () => {
    expect(tokens(':root { --x: system-ui, sans-serif; --gap: 4px; } .a { gap: var(--gap); }')).toEqual([]);
  });

  it('is part of scan()', () => {
    expect(scan(app(BASE + ':root { --t: Arial; } .a { font-family: var(--t); }')).fontTokens).toHaveLength(1);
  });
});

describe('check-system-fonts: the base rule', () => {
  it('passes when the rule is a top-level rule in App.css', () => {
    expect(scan(app(BASE))).toEqual({ hits: [], undefinedTokens: [], fontTokens: [], baseRule: true, baseRuleFaults: [], baseRuleShadows: [], inlineHits: [] });
  });

  it('fails when it is absent', () => {
    expect(scan(app('.a { color: red; }')).baseRule).toBe(false);
    expect(scan([]).baseRule).toBe(false);
  });

  it('fails when the rule is in another file', () => {
    expect(hasBaseRule(sheet(BASE, 'styles/create-studio.css'))).toBe(false);
    expect(hasBaseRule([...app('.a { color: red; }'), { file: 'b.css', source: BASE }])).toBe(false);
    expect(hasBaseRule(sheet(BASE, 'sub/App.css'))).toBe(false);
  });

  it.each([
    ['one of the four tags missing', ':where(button, input, select) { font-family: inherit; font-size: var(--sr-type-control); }'],
    ['the old font: inherit rule', ':where(button, input, select, textarea) { font: inherit; }'],
    ['no size', ':where(button, input, select, textarea) { font-family: inherit; }'],
    ['no family', ':where(button, input, select, textarea) { font-size: var(--sr-type-control); }'],
    ['a size that is not the control token', ':where(button, input, select, textarea) { font-family: inherit; font-size: 13px; }'],
    ['a family that is not inherit', ":where(button, input, select, textarea) { font-family: 'Inter'; font-size: var(--sr-type-control); }"],
    ['a font shorthand beside them', ':where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control); font: initial; }'],
    ['a plain selector, which carries specificity', 'button, input, select, textarea { font-family: inherit; font-size: var(--sr-type-control); }'],
    ['an :is() selector, which takes the specificity of its list', ':is(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control); }'],
    ['a scoped selector', 'body :where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control); }'],
    ['the rule inside a media query', '@media (min-width: 1px) { :where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control); } }'],
    ['the rule inside a layer', '@layer base { :where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control); } }'],
    ['the rule only in a comment', '/* :where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control); } */'],
  ])('fails with %s', (_name, source) => {
    expect(hasBaseRule(app(source))).toBe(false);
  });

  it.each([
    ['reordered tags and declarations', ':where(textarea,select,input,button){font-size:var(--sr-type-control);font-family:inherit}'],
    ['upper-case properties and values', ':where(BUTTON, Input, select, textarea) { FONT-FAMILY: INHERIT; Font-Size: var(--sr-type-control); }'],
    ['extra whitespace and line breaks', ':where( button ,\n  input ,\n select , textarea )\n{\n   font-family :   inherit  ;\n\n   font-size :  var( --sr-type-control )  ;\n}'],
    ['a missing final semicolon', ':where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control) }'],
  ])('accepts %s', (_name, source) => {
    expect(hasBaseRule(app(source))).toBe(true);
    expect(findBaseRuleFaults(app(source))).toEqual([]);
  });

  describe('faults in the base rule', () => {
    const rule = (extra: string) => `:where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control); ${extra} }`;

    it.each([
      ['!important on the size', ':where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control) !important; }', 'font-size: var(--sr-type-control) !important'],
      ['!important on the family', ':where(button, input, select, textarea) { font-family: inherit !important; font-size: var(--sr-type-control); }', 'font-family: inherit !important'],
      ['upper-case ! IMPORTANT with a space', ':where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control) ! IMPORTANT; }', 'font-size: var(--sr-type-control) !important'],
    ])('fails with %s', (_name, source, declaration) => {
      expect(hasBaseRule(app(source))).toBe(false);
      const faults = findBaseRuleFaults(app(source));
      expect(faults).toHaveLength(1);
      expect(faults[0]).toMatchObject({ kind: 'important', declaration, file: 'App.css', line: 1 });
      expect(scan(app(source)).baseRuleFaults).toHaveLength(1);
    });

    it.each([
      ['line-height', rule('line-height: 1.2;'), 'line-height: 1.2'],
      ['font-weight', rule('font-weight: 500;'), 'font-weight: 500'],
      ['font', rule('font: inherit;'), 'font: inherit'],
      ['letter-spacing', rule('letter-spacing: 0.01em;'), 'letter-spacing: 0.01em'],
      ['color, an unrelated property', rule('color: red;'), 'color: red'],
      ['a repeat of font-size', rule('font-size: 20px;'), 'font-size: 20px'],
    ])('fails with an extra %s and names it', (_name, source, declaration) => {
      expect(hasBaseRule(app(source))).toBe(false);
      const faults = findBaseRuleFaults(app(source));
      expect(faults).toHaveLength(1);
      expect(faults[0]).toMatchObject({ kind: 'extra', declaration });
    });

    it('has a message for each that says why', async () => {
      const { BASE_IMPORTANT_MESSAGE, BASE_EXTRA_MESSAGE } = await import('../scripts/check-system-fonts.mjs');
      expect(BASE_IMPORTANT_MESSAGE).toContain('own size');
      expect(BASE_EXTRA_MESSAGE).toContain('line height');
    });
  });

  it('says in its message which file must hold the rule', async () => {
    const { MISSING_BASE_MESSAGE, BASE_SHADOW_MESSAGE } = await import('../scripts/check-system-fonts.mjs');
    expect(MISSING_BASE_MESSAGE).toContain('src/App.css');
    expect(BASE_SHADOW_MESSAGE).toContain('src/App.css');
  });

  it('App.tsx imports ./App.css, the sheet the rule must be in', () => {
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/^import\s+['"]\.\/App\.css['"];?$/m);
  });

  describe('shadowing rules', () => {
    const shadows = (...sheets: Array<{ file: string; source: string }[]>) => findBaseRuleShadows(sheets.flat());

    it('fails a later :where() rule that sets font, in any sheet', () => {
      const found = shadows(app(BASE + ':where(button,input,select,textarea){ font: initial }'));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ file: 'App.css', line: 2, prop: 'font' });
      expect(shadows(app(BASE), sheet(':where(button, input, select, textarea) { font-family: Arial; }', 'x.css'))).toHaveLength(1);
      expect(shadows(app(BASE), sheet(':where(select, button) { font-size: 16px; }', 'x.css'))).toHaveLength(1);
    });

    it('fails a second copy of the base rule, and the base rule in another file', () => {
      expect(shadows(app(BASE + BASE))).toHaveLength(1);
      expect(shadows(sheet(BASE, 'x.css'))).toHaveLength(1);
    });

    it('is part of scan()', () => {
      expect(scan(app(BASE + ':where(button, input, select, textarea) { font: initial; }')).baseRuleShadows).toHaveLength(1);
    });

    it.each([
      ['@media', '@media (min-width: 1px) { :where(button, input, select, textarea) { font-size: 20px; } }'],
      ['@supports', '@supports (display: grid) { :where(button, input) { font-family: Arial; } }'],
      ['@layer', '@layer base { :where(select, textarea) { font: initial; } }'],
      ['@layer inside @media', '@media (min-width: 1px) { @layer base { :where(button) { font-size: 20px; } } }'],
    ])('fails a shadow inside %s, in App.css or another sheet', (_name, group) => {
      for (const sheets of [app(BASE + group), [...app(BASE), { file: 'styles/x.css', source: group }]]) {
        const found = findBaseRuleShadows(sheets);
        expect(found).toHaveLength(1);
        expect(found[0].group).toBe(true);
      }
      expect(scan(app(BASE + group)).baseRuleShadows).toHaveLength(1);
    });

    it('passes a grouped :where() rule that sets no font property', () => {
      expect(shadows(app(BASE + '@media (min-width: 1px) { :where(button, input) { cursor: pointer; } }'))).toEqual([]);
    });

    it.each([
      ['the base rule alone', BASE],
      ['a :where() rule that sets no font property', BASE + ':where(button, input) { cursor: pointer; }'],
      ['a :where() rule over other tags', BASE + ':where(a, label) { font-size: 12px; }'],
      ['a plain button rule', BASE + 'button { font-size: 12px; }'],
      ['a class rule', BASE + '.a:where(button) { font-size: 12px; }'],
    ])('passes %s', (_name, source) => {
      expect(shadows(app(source))).toEqual([]);
    });
  });
});

describe('check-system-fonts: undefined font tokens', () => {
  const undef = (...sheets: string[]) => findUndefinedFontTokens(sheets.map((source, i) => ({ file: `f${i}.css`, source })));

  it('fails a font-family led by a token nobody defines', () => {
    const found = undef('.a { font-family: var(--nope, system-ui, sans-serif); }');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 1, token: '--nope' });
  });

  it('fails the shorthand, with a token size and line height before the family', () => {
    const found = undef('.a { font: 600 var(--size, 9px)/10px var(--nope, system-ui); }');
    expect(found.map((hit) => hit.token)).toEqual(['--nope']);
  });

  it('fails the shorthand with a clamp() size before the family', () => {
    expect(undef('.a { font: clamp(11px, 1vw, 13px) var(--nope, system-ui); }').map((hit) => hit.token)).toEqual(['--nope']);
  });

  it('passes a token defined in the same sheet or another', () => {
    expect(undef('body { --sr-ui: Inter, sans-serif; } .a { font: 600 11px/14px var(--sr-ui); }')).toEqual([]);
    expect(undef('.a { font-family: var(--face, serif); }', ':root { --face: Inter; }')).toEqual([]);
  });

  it('passes a token defined on any selector, in a media block, or minified', () => {
    expect(undef('@media (min-width:1px){.b{--face:Inter}} .a { font-family: var(--face); }')).toEqual([]);
  });

  it('only reads the first family: a later var() or a token size is not checked', () => {
    expect(undef(".a { font-family: 'Inter', var(--nope); }")).toEqual([]);
    expect(undef('.a { font: 500 var(--nope, 12px)/1 Inter, sans-serif; }')).toEqual([]);
  });

  it('names the token of each form', () => {
    expect(firstFamilyVarOf('font-family', 'var(--a, Arial)')).toBe('--a');
    expect(firstFamilyVarOf('font', '12px/1 var(--b)')).toBe('--b');
    expect(firstFamilyVarOf('font', 'clamp(1px, 2px, 3px) var(--c)')).toBe('--c');
    expect(firstFamilyVarOf('font', '12px/1 Arial')).toBeNull();
    expect(firstFamilyVarOf('font-family', 'inherit')).toBeNull();
  });

  it('is part of scan()', () => {
    expect(scan(app(BASE + '.a { font-family: var(--nope); }')).undefinedTokens).toHaveLength(1);
  });
});

describe('check-system-fonts: inline fontFamily strings', () => {
  const inline = (source: string, file = 'components/X.tsx') => findInlineFonts([{ file, source }]);

  it.each([
    ['system-ui', "const s = { fontFamily: 'system-ui' };"],
    ['a stack that leads with a system face', 'const s = { fontFamily: "system-ui, sans-serif" };'],
    ['Georgia', "const s = { fontFamily: 'Georgia, serif' };"],
    ['a bare monospace', "const s = { fontFamily: 'monospace' };"],
  ])('fails %s', (_name, source) => {
    expect(inline(source)).toHaveLength(1);
  });

  it('reports the line', () => {
    expect(inline("const a = 1;\nconst s = {\n  fontFamily: 'Arial',\n};\n").map((hit) => hit.line)).toEqual([3]);
  });

  it.each([
    ['the app face', "const s = { fontFamily: 'Inter, sans-serif' };"],
    ['a var()', "const s = { fontFamily: 'var(--sr-mono)' };"],
    ['a template literal (not read)', 'const s = { fontFamily: `${face}, system-ui` };'],
    ['a computed value (not read)', 'const s = { fontFamily: face };'],
  ])('passes %s', (_name, source) => {
    expect(inline(source)).toEqual([]);
  });

  it('passes the named exceptions, only for their file and family', () => {
    expect(INLINE_EXCEPTIONS.map((entry) => entry.file).sort()).toEqual([
      'components/video-editor/RemotionComposition.tsx',
      'components/video-editor/components/TextRenderer.tsx',
    ]);
    for (const entry of INLINE_EXCEPTIONS) {
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(inline(`const s = { fontFamily: '${entry.family}' };`, entry.file)).toEqual([]);
      expect(inline(`const s = { fontFamily: '${entry.family}' };`, 'components/Other.tsx')).toHaveLength(1);
      expect(inline("const s = { fontFamily: 'Arial' };", entry.file)).toHaveLength(1);
    }
  });

  it('is part of scan()', () => {
    expect(scan(app(BASE), [{ file: 'a.tsx', source: "const s = { fontFamily: 'Arial' };" }]).inlineHits).toHaveLength(1);
  });
});

describe('check-system-fonts: which files are scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'system-fonts-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, text: string) => {
    mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...path.split('/')), text);
  };
  put('App.css', BASE);
  put('styles/a.css', '.a { color: red; }');
  put('extraction/extraction.css', '.x { font-family: -apple-system; }');
  put('extraction/deep/y.css', '.y { color: red; }');
  put('components/A.tsx', "const s = { fontFamily: 'Arial' };");
  put('components/A.test.tsx', "const s = { fontFamily: 'Arial' };");
  put('extraction/main.tsx', "const s = { fontFamily: 'Arial' };");
  put('lib/b.ts', 'export const b = 1;');

  it('collectAppSheets lists every sheet except src/extraction/', () => {
    expect(collectAppSheets(root).map((entry) => entry.file.split('\\').join('/')).sort()).toEqual(['App.css', 'styles/a.css']);
  });

  it('collectAppSources lists .ts and .tsx files except src/extraction/ and tests', () => {
    expect(collectAppSources(root).map((entry) => entry.file.split('\\').join('/')).sort()).toEqual(['components/A.tsx', 'lib/b.ts']);
  });

  it('a hit in an excluded sheet does not reach the scan, and one outside it does', () => {
    expect(scan(collectAppSheets(root), collectAppSources(root))).toMatchObject({ hits: [], baseRule: true });
    put('styles/bad.css', '.b { font-family: -apple-system; }');
    expect(scan(collectAppSheets(root), collectAppSources(root)).hits).toHaveLength(1);
  });

  it('counts a token defined only in an excluded sheet as undefined for the app sheets', () => {
    put('extraction/tokens.css', ':root { --ext-face: Inter; }');
    put('styles/uses.css', '.u { font-family: var(--ext-face, serif); }');
    expect(findUndefinedFontTokens(collectAppSheets(root))).toHaveLength(1);
  });
});

describe('css-scan: line numbers', () => {
  it('reports the right offset for an upper-case property', () => {
    const css = '.a {\n  color: red;\n  FONT-family: Arial;\n}\n';
    const open = css.indexOf('{') + 1;
    const body = css.slice(open, css.indexOf('}'));
    const [color, font] = parseDeclarations(body, open);
    const starts = computeLineStarts(css);
    expect(lineForOffset(starts, color.offset)).toBe(2);
    expect(lineForOffset(starts, font.offset)).toBe(3);
    expect(css.slice(font.offset, font.offset + 4)).toBe('FONT');
  });

  it('flags an upper-case property on the right line', () => {
    expect(hits('.a {\n  color: red;\n\n  FONT-FAMILY: Arial;\n}\n').map((hit) => hit.line)).toEqual([4]);
  });
});

describe('check-system-fonts: the real stylesheets', () => {
  it('pass, with every rule satisfied', () => {
    const out = execFileSync('node', ['scripts/check-system-fonts.mjs', '--json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({ hits: [], undefinedTokens: [], fontTokens: [], baseRule: true, baseRuleFaults: [], baseRuleShadows: [], inlineHits: [] });
  });
});
